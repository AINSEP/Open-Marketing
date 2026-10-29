import { z } from "zod";
import { isDeepStrictEqual } from "node:util";
import { callContextSchema, campaignDeploymentReceiptSchema, idSchema, pluginConfigurationSchema } from "@open-marketing/contracts";
import type { CallOptions, CampaignDeploymentRequired, Outcome } from "@open-marketing/contracts";
import { commandSchema, draftCampaignCommandSchema, draftCreativeCommandSchema, encodeLinkedInCommand, linkedInDigest, vendorIdSchema } from "./commands.js";
import { boundInput, configurationSchema, decodeLinkedInCreativeContent, failure, linkedInApiVersion, readAccountCurrency, requestLinkedIn, resolveCredential } from "./transport.js";
import type { LinkedInDependencies, LinkedInWireRequest } from "./ports.js";

/** One finite DRAFT sequence; only the two approved parent slots may be substituted. */
export const campaignDeploymentPlanSchema = z.strictObject({ group: commandSchema.options[5],
  campaign: draftCampaignCommandSchema.extend({ campaignGroupId: z.strictObject({ from: z.literal("group") }) }),
  creative: draftCreativeCommandSchema.extend({ campaignId: z.strictObject({ from: z.literal("campaign") }) }),
});
const creativeId = z.string().regex(/^urn:li:sponsoredCreative:[1-9][0-9]{0,18}$/);
const referencesSchema = z.strictObject({ group: vendorIdSchema.optional(), campaign: vendorIdSchema.optional(), creative: creativeId.optional() });
type References = z.infer<typeof referencesSchema>;
export type LinkedInDeploymentResult = z.infer<typeof campaignDeploymentReceiptSchema> & { references: References; hierarchy: unknown[] };
const inputSchema = z.strictObject({ context: callContextSchema, operationId: idSchema, plan: campaignDeploymentPlanSchema, configuration: configurationSchema });
type Checked = z.infer<typeof inputSchema> & { dependencies: Omit<LinkedInDependencies, "gateway"> };

/** Execute exactly group -> campaign -> creative inside the owning approved job; no gateway/outbox nesting.
 * @complexity Three bounded creates + four scoped GETs, including group verification before
 * parent substitution; no retry, rollback or continuation.
 * The host checkpoint must reject repeated intents; its fetch rechecks authority after credential lookup.
 * @example deployCampaignPaused({ context, operationId, connectionId, accountId, plan, dependencies, checkpoint, saved })
 */
export async function deployCampaignPaused(required: CampaignDeploymentRequired, optional?: CallOptions): Promise<Outcome<LinkedInDeploymentResult>> {
  if (required.saved.record !== null || Object.keys(required.saved.references).length > 0) return readCampaignDeployment(required, optional);
  const checked = await checkStandardInput({ input: required }, optional);
  if (!checked.ok) return checked;
  const input = { ...checked.value, checkpoint: required.checkpoint };
  const references: References = {};
  for (const step of ["group", "campaign", "creative"] as const) {
    if (!await createStep({ input, step, references }, optional)) return receipt({ references });
  }
  return readSaved({ input, references }, optional);
}

/** Journal intent and candidate ID before its successor. A group candidate requires scoped
 * readback before parent substitution; failed checkpoints/reads stop. O(1) bounded I/O. */
async function createStep(required: { input: Checked & Pick<CampaignDeploymentRequired, "checkpoint">; step: "group" | "campaign" | "creative"; references: References }, optional?: CallOptions): Promise<boolean> {
  const { input, step, references } = required;
  if (optional?.signal?.aborted) return false;
  if (!await checkpoint({ input, step, phase: "dispatch", references })) return false;
  const request = creationRequest({ input, step, references });
  if (!request.ok) return false;
  const response = await send({ input, request: request.value }, optional);
  if (!response.ok || response.value.response.status !== 201) return false;
  const ack = (step === "creative" ? creativeId : vendorIdSchema).safeParse(response.value.response.headers.get("x-restli-id"));
  if (!ack.success) return false;
  references[step] = ack.data;
  if (!await checkpoint({ input, step, phase: "acknowledged", references })) return false;
  if (step === "group") return (await readStep({ input, step, references }, optional)).ok;
  return true;
}

/** GET-only saved-reference reconciliation. Incomplete/foreign/configuration-mismatched rows stay unknown.
 * @example readCampaignDeployment({ context, operationId, connectionId, accountId, plan, dependencies, checkpoint, saved })
 * @complexity At most three bounded GETs plus one metadata GET; no write or discovery scan, O(b) response validation.
 */
export async function readCampaignDeployment(required: CampaignDeploymentRequired, optional?: CallOptions): Promise<Outcome<LinkedInDeploymentResult>> {
  const checked = await checkStandardInput({ input: required }, optional);
  if (!checked.ok) return checked;
  return readSaved({ input: checked.value, references: required.saved.references }, optional);
}

/** GET-only reconciliation reuses checked input, without another metadata request. O(b), at most three bounded reads. */
async function readSaved(required: { input: Checked; references: unknown }, optional?: CallOptions): Promise<Outcome<LinkedInDeploymentResult>> {
  const refs = referencesSchema.safeParse(required.references);
  if (!refs.success) return failure({ code: "invalid_input" });
  const { input } = required;
  const references = refs.data;
  const hierarchy: unknown[] = [];
  for (const step of ["group", "campaign", "creative"] as const) {
    const row = await readStep({ input, step, references }, optional);
    if (!row.ok) return receipt({ references, hierarchy });
    hierarchy.push(row.value);
  }
  return receipt({ references, hierarchy, status: "acknowledged" });
}

/** Verify one scoped row against its fixed creation payload; missing evidence denies. O(b). */
async function readStep(required: { input: Checked; step: "group" | "campaign" | "creative"; references: References }, optional?: CallOptions): Promise<Outcome<unknown>> {
  const { input, step, references } = required;
  const id = references[step];
  if (!id || optional?.signal?.aborted) return failure({ code: "protocol_mismatch" });
  const create = creationRequest({ input, step, references });
  if (!create.ok) return failure({ code: "protocol_mismatch" });
  const response = await send({ input, request: { url: create.value.url + "/" + encodeURIComponent(id), method: "GET", restliMethod: "FINDER" } }, optional);
  if (!response.ok || response.value.response.status !== 200) return failure({ code: "protocol_mismatch" });
  const row = z.record(z.string(), z.unknown()).safeParse(response.value.body);
  const expected = JSON.parse(create.value.body ?? "{}") as Record<string, unknown>;
  if (!row.success || !rowMatches({ row: row.data, id, accountId: input.configuration.accountId, expected })) return failure({ code: "protocol_mismatch" });
  return { ok: true, value: { ...expected, id, account: row.data.account } };
}
/** Compare normalized creative content and exact remaining configuration; require non-serving. O(b). */
function rowMatches(required: { row: Record<string, unknown>; id: string; accountId: string; expected: Record<string, unknown> }): boolean {
  const { row, id, accountId, expected } = required;
  if (String(row.id) !== id || row.account !== `urn:li:sponsoredAccount:${accountId}`) return false;
  let observed = row;
  if (expected.intendedStatus !== undefined) {
    if (row.isServing !== false) return false;
    const content = decodeLinkedInCreativeContent({ input: row.content });
    if (!content.ok) return false;
    observed = { ...row, content: content.value };
  }
  return Object.entries(expected).every(([key, value]) => isDeepStrictEqual(observed[key], value));
}

/** Complete bounded plan/configuration/currency checks precede checkpoints. O(b), no I/O. */
function checkInput(required: { input: Pick<Checked, "context" | "operationId" | "plan" | "dependencies"> }): Outcome<Checked> {
  const input = required.input;
  const bounded = boundInput({ input: { context: input.context, operationId: input.operationId, plan: input.plan, configuration: input.dependencies.configuration } });
  if (!bounded.ok) return bounded;
  const parsed = inputSchema.safeParse(bounded.value);
  if (!parsed.success) return failure({ code: "invalid_input" });
  if (!isDeepStrictEqual(parsed.data.context.scope, parsed.data.configuration.scope)) return failure({ code: "forbidden" });
  const checked = { ...parsed.data, dependencies: input.dependencies };
  const placeholders = { group: "1", campaign: "2" };
  const requests = (["group", "campaign", "creative"] as const).map(step => creationRequest({ input: checked, step, references: placeholders }));
  if (requests.some(request => !request.ok)) return failure({ code: "invalid_input" });
  return { ok: true, value: checked };
}
/** Reuse command encoders with only acknowledged parent IDs. Deterministic names bind operationId. O(c). */
function creationRequest(required: { input: Checked; step: "group" | "campaign" | "creative"; references: References }): Outcome<LinkedInWireRequest> {
  const { input, step, references } = required;
  const marker = "om-" + linkedInDigest({ value: input.operationId }).slice(0, 32);
  const commands = { group: { ...input.plan.group, name: marker }, campaign: { ...input.plan.campaign, name: marker + "-campaign", campaignGroupId: references.group }, creative: { ...input.plan.creative, campaignId: references.campaign } };
  const encoded = encodeLinkedInCommand({ input: commands[step], accountId: input.configuration.accountId, currency: input.configuration.currency });
  return encoded.ok ? { ok: true, value: encoded.value.request } : encoded;
}
/** Redact thrown checkpoint faults; a durable-append failure always stops creation. O(1) I/O. */
async function checkpoint(required: { input: Checked & Pick<CampaignDeploymentRequired, "checkpoint">; step: string; phase: "dispatch" | "acknowledged"; references: References }): Promise<boolean> {
  try { return (await required.input.checkpoint({ step: required.step, phase: required.phase, references: { ...required.references }, record: { step: required.step, phase: required.phase } })).ok; }
  catch { return false; }
}
/** Fresh credentials per call; host fetch supplies final admission/halt/approval fence and durable audit.
 * @complexity One broker access + one <=15s, <=1MiB transport; no token retained or logged.
 */
async function send(required: { input: Checked; request: LinkedInWireRequest }, optional?: CallOptions): ReturnType<typeof requestLinkedIn> {
  const { input } = required;
  if (optional?.signal?.aborted) return failure({ code: "cancelled" });
  try {
    const credential = await resolveCredential({ credentials: input.dependencies.credentials, configuration: input.configuration }, optional);
    if (!credential.ok) return credential;
    if (credential.value.expiresAt !== undefined && credential.value.expiresAt <= input.dependencies.clock.now({})) return failure({ code: "expired" });
    const result = await requestLinkedIn({ fetch: input.dependencies.fetch, request: required.request, credential: credential.value, apiVersion: input.configuration.apiVersion }, optional);
    observe({ input, outcome: result.ok ? "received" : result.error.code });
    return result;
  } catch { return failure({ code: "unavailable" }); }
}
/** Correlated metadata only; the host owns durable audit. O(1), no request or secret data. */
function observe(required: { input: Checked; outcome: string }): void {
  const { context, dependencies } = required.input;
  try { dependencies.observer.observe({ operation: "linkedin-ads.deployment", outcome: required.outcome, correlationId: context.correlationId, traceId: context.traceId, runId: context.runId }); }
  catch { /* Telemetry cannot rewrite an acknowledged vendor outcome. */ }
}
/** Validate explicit draft state for every outcome; O(1), at most three references. */
function receipt(required: { references: References; hierarchy?: unknown[]; status?: LinkedInDeploymentResult["status"] }): Outcome<LinkedInDeploymentResult> {
  const parsed = campaignDeploymentReceiptSchema.safeParse({ status: required.status ?? "unknown", state: "draft", references: { ...required.references }, entityIds: Object.values(required.references), hierarchy: required.hierarchy ?? [] });
  return parsed.success ? { ok: true, value: parsed.data as LinkedInDeploymentResult } : failure({ code: "protocol_mismatch" });
}

/** Validate the neutral envelope before metadata I/O, then reuse plan/currency checks.
 * O(b<=64KiB) plus one bounded metadata GET, no retries or cached credentials. */
async function checkStandardInput(required: { input: CampaignDeploymentRequired }, optional?: CallOptions): Promise<Outcome<Checked>> {
  try {
    const input = required.input;
    const configuration = pluginConfigurationSchema.extend({ accountId: vendorIdSchema }).safeParse(input.dependencies.configuration);
    const plan = campaignDeploymentPlanSchema.safeParse(input.plan);
    const context = callContextSchema.safeParse(input.context);
    if (!configuration.success || !plan.success || !context.success) return failure({ code: "invalid_input" });
    const binding = configuration.data;
    const matches = input.connectionId === binding.connectionId && input.accountId === binding.accountId && isDeepStrictEqual(context.data.scope, binding.scope);
    if (!matches) return failure({ code: "forbidden" });
    const currency = await readAccountCurrency({ ...input.dependencies, connectionId: binding.connectionId, accountId: binding.accountId }, optional);
    if (!currency.ok) return currency;
    const dependencies = { ...input.dependencies, configuration: { scope: binding.scope, connectionId: binding.connectionId, accountId: binding.accountId, pluginDigest: binding.pluginDigest, currency: currency.value, apiVersion: linkedInApiVersion, bindingId: "campaign.create-draft.v1" } };
    return checkInput({ input: { ...input, context: context.data, plan: plan.data, dependencies } });
  } catch { return failure({ code: optional?.signal?.aborted ? "cancelled" : "unavailable" }); }
}
