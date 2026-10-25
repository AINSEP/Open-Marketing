import { z } from "zod";
import { isDeepStrictEqual } from "node:util";
import { callContextSchema, idSchema } from "@open-marketing/contracts";
import type { CallContext, CallOptions, Outcome } from "@open-marketing/contracts";
import { commandSchema, draftCampaignCommandSchema, draftCreativeCommandSchema, encodeLinkedInCommand, linkedInDigest, vendorIdSchema } from "./commands.js";
import { boundInput, configurationSchema, decodeLinkedInCreativeContent, failure, requestLinkedIn, resolveCredential } from "./transport.js";
import type { LinkedInDependencies, LinkedInWireRequest } from "./ports.js";

/** One finite DRAFT sequence; only the two approved parent slots may be substituted. */
export const campaignDeploymentPlanSchema = z.strictObject({ group: commandSchema.options[5],
  campaign: draftCampaignCommandSchema.extend({ campaignGroupId: z.strictObject({ from: z.literal("group") }) }),
  creative: draftCreativeCommandSchema.extend({ campaignId: z.strictObject({ from: z.literal("campaign") }) }),
});
const creativeId = z.string().regex(/^urn:li:sponsoredCreative:[1-9][0-9]{0,18}$/);
const referencesSchema = z.strictObject({ group: vendorIdSchema.optional(), campaign: vendorIdSchema.optional(), creative: creativeId.optional() });
type References = z.infer<typeof referencesSchema>;
export interface LinkedInDeploymentResult { status: "acknowledged" | "unknown"; entityIds: string[]; references: References; hierarchy: unknown[] }
type Checkpoint = (input: { step: string; phase: "dispatch" | "acknowledged"; references: References }) => Promise<Outcome<void>>;
interface Input { context: CallContext; operationId: string; plan: unknown; dependencies: Omit<LinkedInDependencies, "gateway"> & { admitted: boolean }; checkpoint: Checkpoint }
const inputSchema = z.strictObject({ context: callContextSchema, operationId: idSchema, plan: campaignDeploymentPlanSchema, configuration: configurationSchema });
type Checked = z.infer<typeof inputSchema> & Pick<Input, "dependencies">;

/** Execute exactly group -> campaign -> creative inside the owning approved job; no gateway/outbox nesting.
 * @complexity Three bounded creates + four scoped GETs, including group verification before
 * parent substitution; no retry, rollback or continuation.
 * The host checkpoint must reject repeated intents; its fetch rechecks authority after credential lookup.
 */
export async function deployCampaignPaused(required: Input, optional?: CallOptions): Promise<Outcome<LinkedInDeploymentResult>> {
  const checked = checkInput({ input: required });
  if (!checked.ok) return checked;
  const input = { ...checked.value, checkpoint: required.checkpoint };
  const references: References = {};
  for (const step of ["group", "campaign", "creative"] as const) {
    if (!await createStep({ input, step, references }, optional)) return receipt({ references });
  }
  return readCampaignDeployment({ ...input, references }, optional);
}

/** Journal intent and candidate ID before its successor. A group candidate requires scoped
 * readback before parent substitution; failed checkpoints/reads stop. O(1) bounded I/O. */
async function createStep(required: { input: Checked & Pick<Input, "checkpoint">; step: "group" | "campaign" | "creative"; references: References }, optional?: CallOptions): Promise<boolean> {
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
 * @complexity At most three bounded GETs; no write or discovery scan, O(b) response validation.
 */
export async function readCampaignDeployment(required: Omit<Input, "checkpoint"> & { references: unknown }, optional?: CallOptions): Promise<Outcome<LinkedInDeploymentResult>> {
  const checked = checkInput({ input: required });
  if (!checked.ok) return checked;
  const refs = referencesSchema.safeParse(required.references);
  if (!refs.success) return failure({ code: "invalid_input" });
  const input = checked.value;
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

/** Complete bounded plan/configuration/currency checks precede any credentials or checkpoint. O(b). */
function checkInput(required: { input: Omit<Input, "checkpoint"> }): Outcome<Checked> {
  const input = required.input;
  if (input.dependencies.admitted !== true) return failure({ code: "forbidden" });
  const bounded = boundInput({ input: { context: input.context, operationId: input.operationId, plan: input.plan, configuration: input.dependencies.configuration } });
  if (!bounded.ok) return bounded;
  const parsed = inputSchema.safeParse(bounded.value);
  if (!parsed.success) return failure({ code: "invalid_input" });
  if (!isDeepStrictEqual(parsed.data.context.scope, parsed.data.configuration.scope)) return failure({ code: "forbidden" });
  const checked = { ...input, ...parsed.data };
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
async function checkpoint(required: { input: Checked & Pick<Input, "checkpoint">; step: string; phase: "dispatch" | "acknowledged"; references: References }): Promise<boolean> {
  try { return (await required.input.checkpoint({ step: required.step, phase: required.phase, references: { ...required.references } })).ok; }
  catch { return false; }
}
/** Fresh credentials per call; host fetch supplies final admission/halt/approval fence and durable audit.
 * @complexity One broker access + one <=15s, <=1MiB transport; no token retained or logged.
 */
async function send(required: { input: Checked; request: LinkedInWireRequest }, optional?: CallOptions): ReturnType<typeof requestLinkedIn> {
  const { input } = required;
  if (input.dependencies.admitted !== true) return failure({ code: "forbidden" });
  if (optional?.signal?.aborted) return failure({ code: "cancelled" });
  try {
    const credential = await resolveCredential({ credentials: input.dependencies.credentials, configuration: input.configuration }, optional);
    if (!credential.ok) return credential;
    if (input.dependencies.admitted !== true) return failure({ code: "forbidden" });
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
function receipt(required: { references: References; hierarchy?: unknown[]; status?: LinkedInDeploymentResult["status"] }): Outcome<LinkedInDeploymentResult> { return { ok: true, value: { status: required.status ?? "unknown", references: { ...required.references }, entityIds: Object.values(required.references), hierarchy: required.hierarchy ?? [] } }; }
