/** Server-job backend. The host owns the single grouped card, outbox, authority fence and audit. */
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { callContextSchema, idSchema } from "@open-marketing/contracts";
import type { CallContext, CallOptions, Outcome } from "@open-marketing/contracts";
import { request, vendorIdSchema } from "./commands.js";
import { boundInput, campaignDeploymentPlanSchema } from "./campaign-translation.js";
import type { MicrosoftPausedPlan } from "./campaign-translation.js";
import { configurationSchema, requestMicrosoftAds } from "./transport.js";
import type { MicrosoftAdsTransportResult } from "./transport.js";
import { failure } from "./ports.js";
import type { MicrosoftAdsIoDependencies } from "./ports.js";

export { campaignDeploymentPlanSchema } from "./campaign-translation.js";
const steps = ["campaign", "locations", "adGroup", "keywords", "ad"] as const;
type Step = typeof steps[number];
const referencesSchema = z.record(z.string().regex(/^(campaign|adGroup|ad|locationIntent|location\d{1,2}|keyword\d{1,3}|extra_[a-zA-Z]+_\d{1,3})$/), vendorIdSchema).refine(value => Object.keys(value).length <= 256);
export type MicrosoftDeploymentReferences = z.infer<typeof referencesSchema>;
export interface MicrosoftDeploymentResult { status: "acknowledged" | "unknown"; references: MicrosoftDeploymentReferences; entityIds: string[]; hierarchy: unknown[] }
/** Atomically claim each operation/step BEFORE egress, reject replay even after unknown outcome,
 * then append ALL candidate IDs before a successor. No second outbox is constructed here. */
export type MicrosoftDeploymentCheckpoint = (required: { step: string; phase: "dispatch" | "acknowledged"; references: MicrosoftDeploymentReferences }) => Promise<Outcome<void>>;
export interface DeploymentInput { context: CallContext; operationId: string; plan: unknown; dependencies: MicrosoftAdsIoDependencies; checkpoint: MicrosoftDeploymentCheckpoint }
export type DeploymentReadInput = Omit<DeploymentInput, "checkpoint"> & { references: unknown };
const inputSchema = z.strictObject({ context: callContextSchema, operationId: idSchema, plan: campaignDeploymentPlanSchema, configuration: configurationSchema });
type Checked = z.infer<typeof inputSchema> & { dependencies: MicrosoftAdsIoDependencies; liveConfiguration: MicrosoftAdsIoDependencies["configuration"] };
type Shape = { path: string; collection: string; ids: string; keys: string[]; rows: Record<string, unknown>[]; parent: Record<string, unknown> };
const providerId = z.union([vendorIdSchema, z.number().int().positive().max(Number.MAX_SAFE_INTEGER).transform(String)]);
const responseSchema = z.object({ PartialErrors: z.array(z.unknown()).max(100).nullish().transform(value => value ?? []) });

/** Create -> save IDs -> scoped readback for every step; no activation, rollback or retries.
 * @param required - Frozen reviewed plan, server effects and owning outbox checkpoints.
 * @returns Candidate refs on any uncertainty; acknowledged only after a final full readback.
 * @example deployCampaignPaused({ context, operationId, plan, dependencies, checkpoint })
 * @complexity Five mutations, <=12 fixed read RPCs; <=100 keywords/20 locations; each <=15s/1MiB.
 */
export async function deployCampaignPaused(required: DeploymentInput, optional?: CallOptions): Promise<Outcome<MicrosoftDeploymentResult>> {
  const checked = checkInput({ input: required }, optional);
  if (!checked.ok) return checked;
  const references: MicrosoftDeploymentReferences = {};
  for (const step of steps) {
    const complete = await createStep({ input: checked.value, checkpoint: required.checkpoint, references, step }, optional);
    if (!complete) return receipt({ references });
  }
  return readAll({ input: checked.value, references }, optional);
}

/** Saved-reference reconciliation only; missing IDs never trigger discovery or recreation.
 * Microsoft documents POST query RPCs rather than GET. Until the Coordinator resolves that
 * mismatch with the dispatch's literal GET-only rule, reconciliation is unsupported, zero I/O.
 * @example readCampaignDeployment({ context, operationId, plan, dependencies, references })
 * @complexity O(b<=64KiB), validation only; no credentials or network.
 */
export async function readCampaignDeployment(required: DeploymentReadInput, optional?: CallOptions): Promise<Outcome<MicrosoftDeploymentResult>> {
  const checked = checkInput({ input: required }, optional);
  if (!checked.ok) return checked;
  if (!referencesSchema.safeParse(required.references).success) return failure({ code: "invalid_input" });
  return failure({ code: "not_implemented" });
}

/** Snapshot the full plan/binding before checkpoints. Admission and account/scope must match. */
function checkInput(required: { input: Omit<DeploymentInput, "checkpoint"> }, optional?: CallOptions): Outcome<Checked> {
  const { input } = required;
  if (!input.dependencies.configuration.admitted) return failure({ code: "forbidden" });
  if (optional?.signal?.aborted) return failure({ code: "cancelled" });
  const bounded = boundInput({ input: { context: input.context, operationId: input.operationId, plan: input.plan, configuration: input.dependencies.configuration } });
  if (!bounded.ok) return bounded;
  const parsed = inputSchema.safeParse(bounded.value);
  if (!parsed.success) return failure({ code: "not_implemented" });
  const { configuration, context, plan } = parsed.data;
  if (!isDeepStrictEqual(context.scope, configuration.scope) || configuration.accountId !== plan.accountId || configuration.currency !== plan.currency || !configuration.customerId) return failure({ code: "forbidden" });
  return { ok: true, value: { ...parsed.data, liveConfiguration: input.dependencies.configuration, dependencies: { ...input.dependencies, configuration } } };
}

/** Checkpoint IDs even from late/malformed ACKs before stopping; never read or create after expiry.
 * @complexity O(n<=100) time/space for candidate IDs; one mutation and two checkpoints per step.
 */
async function createStep(required: { input: Checked; checkpoint: MicrosoftDeploymentCheckpoint; references: MicrosoftDeploymentReferences; step: Step }, optional?: CallOptions): Promise<boolean> {
  const { input, references, step } = required;
  if (optional?.signal?.aborted) return false;
  if (!await checkpoint({ ...required, phase: "dispatch" })) return false;
  const shape = stepShape({ plan: input.plan, references, step });
  const response = await send({ input, path: shape.path, body: { ...shape.parent, [shape.collection]: shape.rows } }, optional);
  if (!response.ok && response.receivedBody === undefined) return false;
  const ack = collectIds({ shape, references, step, body: response.ok ? response.value : response.receivedBody });
  const saved = await checkpoint({ ...required, phase: "acknowledged" });
  if (!response.ok || !ack || !saved) return false;
  return (await readStep({ input, references, step }, optional)).ok;
}

/** Extract every valid returned ID before inspecting PartialErrors; never use error text. O(n<=100). */
function collectIds(required: { shape: Shape; references: MicrosoftDeploymentReferences; step: Step; body: unknown }): boolean {
  const body = z.record(z.string(), z.unknown()).safeParse(required.body);
  if (!body.success) return false;
  const ids = body.data[required.shape.ids];
  if (!Array.isArray(ids) || ids.length > 100) return false;
  for (const [index, raw] of ids.entries()) {
    const id = providerId.safeParse(raw);
    if (id.success) required.references[required.shape.keys[index] ?? `extra_${required.step}_${index}`] = id.data;
  }
  const errors = responseSchema.safeParse(body.data);
  return ids.length === required.shape.keys.length && ids.every(raw => providerId.safeParse(raw).success)
    && new Set(ids.map(String)).size === ids.length && errors.success && errors.data.PartialErrors.length === 0;
}

/** Fixed private operation table, with only acknowledged parent IDs substituted. No arbitrary RPCs. */
function stepShape(required: { plan: MicrosoftPausedPlan; references: MicrosoftDeploymentReferences; step: Step }): Shape {
  const { plan, references: refs, step } = required;
  switch (step) {
    case "campaign": return { path: "Campaigns", collection: "Campaigns", ids: "CampaignIds", keys: ["campaign"], rows: [plan.campaign], parent: { AccountId: plan.accountId } };
    case "locations": return { path: "CampaignCriterions", collection: "CampaignCriterions", ids: "CampaignCriterionIds", keys: [...plan.locations.map((_, index) => "location" + index), "locationIntent"], parent: { CriterionType: "Targets" },
      rows: [...plan.locations.map(item => ({ Type: "BiddableCampaignCriterion", CampaignId: refs.campaign, Criterion: { Type: "LocationCriterion", LocationId: item.id } })), { Type: "BiddableCampaignCriterion", CampaignId: refs.campaign, Criterion: { Type: "LocationIntentCriterion", IntentOption: plan.locationIntent } }] };
    case "adGroup": return { path: "AdGroups", collection: "AdGroups", ids: "AdGroupIds", keys: ["adGroup"], rows: [plan.adGroup], parent: { CampaignId: refs.campaign } };
    case "keywords": return { path: "Keywords", collection: "Keywords", ids: "KeywordIds", keys: plan.keywords.map((_, index) => "keyword" + index), rows: plan.keywords, parent: { AdGroupId: refs.adGroup } };
    case "ad": return { path: "Ads", collection: "Ads", ids: "AdIds", keys: ["ad"], rows: [plan.ad], parent: { AdGroupId: refs.adGroup } };
    default: { const exhaustive: never = step; return exhaustive; }
  }
}

/** Final full readback detects parent/configuration drift after children were created. */
async function readAll(required: { input: Checked; references: MicrosoftDeploymentReferences }, optional?: CallOptions): Promise<Outcome<MicrosoftDeploymentResult>> {
  const hierarchy: unknown[] = [];
  for (const step of steps) {
    const observed = await readStep({ ...required, step }, optional);
    if (!observed.ok) return receipt({ references: required.references, hierarchy });
    hierarchy.push(observed.value);
  }
  return receipt({ references: required.references, hierarchy, status: "acknowledged" });
}

/** Scoped QueryByIds operations are POST reads in the official REST SDK; no list/name scans. */
async function readStep(required: { input: Checked; references: MicrosoftDeploymentReferences; step: Step }, optional?: CallOptions): Promise<Outcome<unknown>> {
  const shape = stepShape({ plan: required.input.plan, ...required });
  if (shape.keys.some(key => !required.references[key])) return failure({ code: "protocol_mismatch" });
  const campaign = { CampaignId: required.references.campaign };
  const queries: Partial<Record<Step, { keys: string[]; parent: Record<string, unknown>; extra?: Record<string, unknown> }[]>> = {
    locations: [{ keys: shape.keys.slice(0, -1), parent: { ...campaign, CriterionType: "Location" } }, { keys: ["locationIntent"], parent: { ...campaign, CriterionType: "LocationIntent" } }],
    ad: [{ keys: shape.keys, parent: shape.parent, extra: { AdTypes: ["ResponsiveSearch"] } }],
  };
  const rows: unknown[] = [];
  for (const { keys, parent, extra } of queries[required.step] ?? [{ keys: shape.keys, parent: shape.parent }]) {
    const body = { ...parent, [shape.ids]: keys.map(key => required.references[key]), ...extra };
    const response = await send({ input: required.input, path: shape.path + "/QueryByIds", body }, optional);
    if (!response.ok) return response;
    const decoded = decodeRows({ shape, keys, references: required.references, body: response.value, ownership: { AccountId: required.input.configuration.accountId, CampaignId: required.references.campaign, ...shape.parent, ...parent } });
    if (!decoded.ok) return decoded;
    rows.push(...decoded.value);
  }
  return { ok: true, value: { step: required.step, rows } };
}

/** Null error slots mean successful reads; any non-null error rejects before comparing scoped rows.
 * @complexity O(b<=1MiB) time/space across <=100 rows and schema-fixed reviewed fields.
 */
function decodeRows(required: { shape: Shape; keys: string[]; references: MicrosoftDeploymentReferences; body: unknown; ownership: Record<string, unknown> }): Outcome<unknown[]> {
  const body = responseSchema.extend({ [required.shape.collection]: z.array(z.unknown()).max(100) }).safeParse(required.body);
  if (!body.success || body.data.PartialErrors.some(error => error !== null)) return failure({ code: "protocol_mismatch" });
  const raw = body.data[required.shape.collection] as unknown[];
  if (raw.length !== required.keys.length) return failure({ code: "protocol_mismatch" });
  const rows = raw.map((row, index) => projectRow({ row, expected: required.shape.rows[required.shape.keys.indexOf(required.keys[index])], id: required.references[required.keys[index]], ownership: required.ownership }));
  if (rows.some(row => !row.ok)) return failure({ code: "protocol_mismatch" });
  return { ok: true, value: rows.map(row => row.ok ? row.value : undefined) };
}

/** Recursively project only approved fields; identifiers/assets metadata cannot mask drift.
 * @complexity O(b), bounded response with schema-fixed expected depth <=5; no arbitrary recursion.
 */
function projectRow(required: { row: unknown; expected: Record<string, unknown>; id: string; ownership: Record<string, unknown> }): Outcome<unknown> {
  const parsed = z.record(z.string(), z.unknown()).safeParse(required.row);
  if (!parsed.success) return failure({ code: "protocol_mismatch" });
  const row = parsed.data;
  if (!ownerMatches({ row, ownership: required.ownership })) return failure({ code: "protocol_mismatch" });
  if (normalizedId({ value: row.Id }) !== required.id) return failure({ code: "protocol_mismatch" });
  if (!unshared({ row })) return failure({ code: "protocol_mismatch" });
  if (required.expected.Type === "BiddableCampaignCriterion" && row.Status !== "Active") return failure({ code: "protocol_mismatch" });
  if (!matches({ actual: row, expected: required.expected })) return failure({ code: "protocol_mismatch" });
  return { ok: true, value: { Id: required.id, ...required.expected } };
}
/** Parent-scoped query is the ownership boundary; any explicit conflicting owner also rejects. */
function ownerMatches(required: { row: Record<string, unknown>; ownership: Record<string, unknown> }): boolean {
  return ["AccountId", "CampaignId", "AdGroupId"].every(key => required.row[key] === undefined || required.ownership[key] === undefined || normalizedId({ value: required.row[key] }) === required.ownership[key]);
}
/** Schema-shaped subset equality permits asset IDs/editorial metadata but rejects pinning. */
function matches(required: { actual: unknown; expected: unknown }): boolean {
  if (Array.isArray(required.expected)) return arrayMatches({ actual: required.actual, expected: required.expected });
  if (required.expected === null || typeof required.expected !== "object") return isDeepStrictEqual(required.actual, required.expected);
  const row = z.record(z.string(), z.unknown()).safeParse(required.actual);
  if (!row.success || (row.data.PinnedField !== undefined && row.data.PinnedField !== null)) return false;
  return Object.entries(required.expected).every(([key, expected]) => matches({ actual: normalizeField({ key, actual: row.data[key] }), expected }));
}

/** Compare fixed asset/URL arrays in reviewed order without accepting additional entries. */
function arrayMatches(required: { actual: unknown; expected: unknown[] }): boolean {
  if (!Array.isArray(required.actual) || required.actual.length !== required.expected.length) return false;
  const actual = required.actual;
  return required.expected.every((item, index) => matches({ actual: actual[index], expected: item }));
}
/** Shared budget/portfolio bids must stay absent; REST may encode the zero sentinel as a string. */
function unshared(required: { row: Record<string, unknown> }): boolean {
  return ["BudgetId", "BidStrategyId"].every(key => required.row[key] == null || required.row[key] === 0 || required.row[key] === "0");
}
/** Exact-range long parser used for returned IDs and any explicit parent identifiers. */
function normalizedId(required: { value: unknown }): string | null {
  const parsed = providerId.safeParse(required.value);
  return parsed.success ? parsed.data : null;
}
/** REST long IDs may be strings/numbers within the exact range. Microsoft documents both
 * JSON discriminator names and shorter retrieved names; normalize only these known equivalents. */
function normalizeField(required: { key: string; actual: unknown }): unknown {
  if (["CampaignId", "LocationId"].includes(required.key)) return normalizedId({ value: required.actual });
  if (required.key !== "Type") return required.actual;
  const aliases: Record<string, string> = { MaxClicksBiddingScheme: "MaxClicks", Location: "LocationCriterion", LocationIntent: "LocationIntentCriterion" };
  return typeof required.actual === "string" ? aliases[required.actual] ?? required.actual : required.actual;
}

/** Host fetch fences authority after BOTH credential reads; preserve late bodies for ID collection.
 * @complexity One <=15s/1MiB request; correlated telemetry excludes response bodies.
 */
async function send(required: { input: Checked; path: string; body: unknown }, optional?: CallOptions): Promise<MicrosoftAdsTransportResult> {
  if (!required.input.liveConfiguration.admitted) return failure({ code: "forbidden" });
  let result: MicrosoftAdsTransportResult;
  try { result = await requestMicrosoftAds({ dependencies: required.input.dependencies, request: request({ service: "CampaignManagement", path: required.path, body: required.body }) }, optional); }
  catch { result = failure({ code: "unavailable" }); }
  const { context, dependencies } = required.input;
  try { dependencies.observer.observe({ operation: "microsoft-ads.deployment", outcome: result.ok ? "received" : result.error.code, correlationId: context.correlationId, traceId: context.traceId, runId: context.runId }); } catch { /* Host audit is authoritative. */ }
  return result;
}
/** Append failures stop progress; snapshots prevent checkpoint callers from changing our refs. */
async function checkpoint(required: { checkpoint: MicrosoftDeploymentCheckpoint; step: Step; references: MicrosoftDeploymentReferences; phase: "dispatch" | "acknowledged" }): Promise<boolean> {
  try { return (await required.checkpoint({ step: required.step, phase: required.phase, references: { ...required.references } })).ok; } catch { return false; }
}
/** Known candidates survive every uncertain path, independently of durable checkpoint success. */
function receipt(required: { references: MicrosoftDeploymentReferences; hierarchy?: unknown[]; status?: MicrosoftDeploymentResult["status"] }): Outcome<MicrosoftDeploymentResult> {
  return { ok: true, value: { status: required.status ?? "unknown", references: { ...required.references }, entityIds: Object.values(required.references), hierarchy: required.hierarchy ?? [] } };
}
