/** Fixed PAUSED hierarchy inside OM's existing approved job, with GET-only recovery. */
import { z } from "zod";
import { isDeepStrictEqual } from "node:util";
import { callContextSchema, idSchema } from "@open-marketing/contracts";
import type { CallOptions, Outcome } from "@open-marketing/contracts";
import { failure, integer, success, vendorId } from "./commands.js";
import { campaignDeploymentPlanSchema } from "./campaign-translation.js";
import { beforeEgress, boundInput, configurationSchema, requestSnapchat, resolveCredential } from "./transport.js";
import type { SnapchatDeploymentInput, SnapchatDeploymentReferences as References, SnapchatDeploymentResult } from "./ports.js";

const steps = ["campaign", "squad", "ad"] as const;
type Step = typeof steps[number];
const kinds = { campaign: ["campaigns", "campaign"], squad: ["adsquads", "adsquad"], ad: ["ads", "ad"] } as const;
const referencesSchema = z.strictObject({ campaign: vendorId.optional(), squad: vendorId.optional(), ad: vendorId.optional() });
const inputSchema = z.strictObject({ context: callContextSchema, operationId: idSchema, plan: campaignDeploymentPlanSchema, configuration: configurationSchema });
type Checked = z.infer<typeof inputSchema> & Pick<SnapchatDeploymentInput, "dependencies">;
type Request = { url: string; method: "POST" | "GET"; body?: string };

/** Three creates, each followed by readback before its successor; never activates or retries.
 * @param required - Frozen plan and owning-job dependencies/checkpoint; fetch MUST be host-guarded.
 * @returns All known IDs, acknowledged only after complete PAUSED readback; typed preflight denials.
 * @example deployCampaignPaused({ context, operationId, plan, dependencies, checkpoint })
 * @complexity At most 1 creative GET + 3 POSTs + 3 entity GETs, each <=15s/1MiB; O(b) space.
 */
export async function deployCampaignPaused(required: SnapchatDeploymentInput, optional: CallOptions = {}): Promise<Outcome<SnapchatDeploymentResult>> {
  const checked = checkInput({ input: required });
  if (!checked.ok) return checked;
  const input = { ...checked.value, checkpoint: required.checkpoint };
  const references: References = {}, hierarchy: unknown[] = [];
  if (!(await readCreative({ input }, optional)).ok) return receipt({ references });
  for (const step of steps) {
    if (!await createStep({ input, step, references }, optional)) return receipt({ references, hierarchy });
    const row = await readStep({ input, step, references }, optional);
    if (!row.ok) return receipt({ references, hierarchy });
    hierarchy.push(row.value);
  }
  return receipt({ references, hierarchy, status: "acknowledged" });
}
/** Read saved IDs only. Missing IDs stay unknown; never search by name, create or resume.
 * @param required - Original plan/binding and durable references under current read authority.
 * @returns Current complete hierarchy or an unknown receipt preserving all validated IDs.
 * @example readCampaignDeployment({ context, operationId, plan, dependencies, references })
 * @complexity <=4 GETs, O(b) bounded validation; zero writes/checkpoint claims.
 */
export async function readCampaignDeployment(required: Omit<SnapchatDeploymentInput, "checkpoint"> & { references: unknown }, optional: CallOptions = {}): Promise<Outcome<SnapchatDeploymentResult>> {
  const checked = checkInput({ input: required });
  if (!checked.ok) return checked;
  const refs = referencesSchema.safeParse(required.references);
  if (!refs.success) return failure({ code: "invalid_input" });
  const references = refs.data, hierarchy: unknown[] = [];
  if (!references.campaign) return receipt({ references });
  if (!(await readCreative({ input: checked.value }, optional)).ok) return receipt({ references });
  for (const step of steps) {
    if (!references[step]) return receipt({ references, hierarchy });
    const row = await readStep({ input: checked.value, step, references }, optional);
    if (!row.ok) return receipt({ references, hierarchy });
    hierarchy.push(row.value);
  }
  return receipt({ references, hierarchy, status: "acknowledged" });
}
/** Parse/copy the complete bounded intent before any awaited host code; pure O(b). */
function checkInput(required: { input: Omit<SnapchatDeploymentInput, "checkpoint"> }): Outcome<Checked> {
  const input = required.input;
  if (input.dependencies.admitted !== true) return failure({ code: "forbidden" });
  const bounded = boundInput({ input: { context: input.context, operationId: input.operationId, plan: input.plan, configuration: input.dependencies.configuration } });
  if (!bounded.ok) return bounded;
  const parsed = inputSchema.safeParse(bounded.value);
  if (!parsed.success) return failure({ code: "not_implemented" });
  const { configuration, plan, context } = parsed.data;
  if (!isDeepStrictEqual(context.scope, configuration.scope) || configuration.accountId !== plan.campaign.ad_account_id
    || configuration.currency !== plan.currency || configuration.timezone !== plan.timezone) return failure({ code: "forbidden" });
  return { ok: true, value: { ...parsed.data, dependencies: input.dependencies } };
}
/** Persist intent before POST and any sole candidate ID before evaluating success; O(b).
 * Candidate retention is deliberate even if HTTP/envelope success is uncertain. */
async function createStep(required: { input: Checked & Pick<SnapchatDeploymentInput, "checkpoint">; step: Step; references: References }, optional: CallOptions): Promise<boolean> {
  const { input, step, references } = required;
  if (optional.signal?.aborted) return false;
  if (!await checkpoint({ ...required, phase: "dispatch" })) return false;
  const request = creationRequest(required);
  const response = await send({ input, request }, optional);
  if (!response.ok) return false;
  const candidate = entity({ body: response.value.body, step });
  if (!candidate.ok) return false;
  references[step] = candidate.value.id;
  if (!await checkpoint({ ...required, phase: "acknowledged" })) return false;
  return response.value.status >= 200 && response.value.status < 300 && candidate.value.succeeded;
}
/** Only the two reviewed parent slots change. All other bytes come from the parsed plan. O(b). */
function creationRequest(required: { input: Checked; step: Step; references: References }): Request {
  const { plan } = required.input, refs = required.references;
  const paths = { campaign: "adaccounts/" + plan.campaign.ad_account_id + "/campaigns", squad: "campaigns/" + refs.campaign + "/adsquads", ad: "adsquads/" + refs.squad + "/ads" };
  return { url: "https://adsapi.snapchat.com/v1/" + paths[required.step], method: "POST", body: JSON.stringify({ [kinds[required.step][0]]: [expectedRow(required)] }) };
}
/** Pure exact payload for a step, with only acknowledged parent IDs substituted. O(1). */
function expectedRow(required: { input: Checked; step: Step; references: References }): Record<string, unknown> {
  const { plan } = required.input;
  switch (required.step) {
    case "campaign": return plan.campaign;
    case "squad": return { ...plan.squad, campaign_id: required.references.campaign };
    case "ad": return { ...plan.ad, ad_squad_id: required.references.squad };
    default: { const exhaustive: never = required.step; throw new Error(String(exhaustive)); }
  }
}
/** Validate envelope/cardinality and candidate ID separately from success; strip provider extras. O(b). */
function entity(required: { body: unknown; step: Step }): Outcome<{ id: string; row: Record<string, unknown>; succeeded: boolean }> {
  const [plural, singular] = kinds[required.step];
  const parsed = z.object({ request_status: z.unknown().optional(), [plural]: z.array(z.object({ sub_request_status: z.unknown().optional(), [singular]: z.object({ id: vendorId }).passthrough() })).length(1) }).safeParse(required.body);
  if (!parsed.success) return failure({ code: "protocol_mismatch" });
  const item = (parsed.data[plural] as Record<string, unknown>[])[0];
  const row = item[singular] as Record<string, unknown> & { id: string };
  return { ok: true, value: { id: row.id, row, succeeded: success.safeParse(parsed.data.request_status).success && success.safeParse(item.sub_request_status).success } };
}
/** Verify exact PAUSED payload and saved identity, including parent ownership/budget/schedule. O(b). */
async function readStep(required: { input: Checked; step: Step; references: References }, optional: CallOptions): Promise<Outcome<unknown>> {
  const id = required.references[required.step];
  if (!id) return failure({ code: "protocol_mismatch" });
  const result = await send({ input: required.input, request: { method: "GET", url: "https://adsapi.snapchat.com/v1/" + kinds[required.step][0] + "/" + id } }, optional);
  if (!result.ok || result.value.status !== 200) return failure({ code: "protocol_mismatch" });
  const row = entity({ body: result.value.body, step: required.step });
  const expected = expectedRow(required);
  if (!row.ok || !row.value.succeeded || row.value.id !== id || !rowMatches({ row: row.value.row, expected })) return failure({ code: "protocol_mismatch" });
  return { ok: true, value: { ...expected, id } };
}
/** Money permits lossless decimal strings; schedule compares instants. Other fields match exactly. O(b). */
function rowMatches(required: { row: Record<string, unknown>; expected: Record<string, unknown> }): boolean {
  return Object.entries(required.expected).every(([key, expected]) => {
    const observed = required.row[key];
    if (key.endsWith("_micro")) return integer.safeParse(observed).success && String(observed) === String(expected);
    if (key.endsWith("_time")) return typeof observed === "string" && Date.parse(observed) === Date.parse(String(expected));
    return isDeepStrictEqual(observed, expected);
  });
}
/** Existing asset must still be account-owned WEB_VIEW before creation/read reconciliation. O(b). */
async function readCreative(required: { input: Checked }, optional: CallOptions): Promise<Outcome<void>> {
  const input = required.input;
  const result = await send({ input, request: { method: "GET", url: "https://adsapi.snapchat.com/v1/creatives/" + input.plan.ad.creative_id } }, optional);
  if (!result.ok || result.value.status !== 200) return failure({ code: "protocol_mismatch" });
  const parsed = z.object({ request_status: success, creatives: z.array(z.object({ sub_request_status: success,
    creative: z.object({ id: vendorId, ad_account_id: vendorId, type: z.literal("WEB_VIEW") }) })).length(1) }).safeParse(result.value.body);
  if (!parsed.success) return failure({ code: "protocol_mismatch" });
  const creative = parsed.data.creatives[0].creative;
  return creative.id === input.plan.ad.creative_id && creative.ad_account_id === input.configuration.accountId ? { ok: true, value: undefined } : failure({ code: "forbidden" });
}
/** Checkpoint exceptions never escape or allow a successor. Copies isolate receipt mutation. O(1). */
async function checkpoint(required: { input: Checked & Pick<SnapchatDeploymentInput, "checkpoint">; step: Step; phase: "dispatch" | "acknowledged"; references: References }): Promise<boolean> {
  try { return (await required.input.checkpoint({ step: required.step, phase: required.phase, references: { ...required.references } })).ok; }
  catch { return false; }
}
/** Token per request, then current host-guarded fetch; correlated outcomes only, no secret/body logs. O(b). */
async function send(required: { input: Checked; request: Request }, optional: CallOptions): ReturnType<typeof requestSnapchat> {
  const { input } = required;
  if (!input.dependencies.admitted) return failure({ code: "forbidden" });
  try {
    const credential = await resolveCredential({ dependencies: input.dependencies, configuration: input.configuration }, optional);
    if (!credential.ok) return credential;
    const current = beforeEgress({ dependencies: input.dependencies, credential: credential.value }, optional);
    if (!current.ok) return current;
    const result = await requestSnapchat({ fetch: input.dependencies.fetch, credential: credential.value, request: required.request }, optional);
    try { input.dependencies.observer.observe({ operation: "snapchat-ads.deployment", outcome: result.ok ? "received" : result.error.code,
      correlationId: input.context.correlationId, traceId: input.context.traceId, runId: input.context.runId }); } catch { /* Host owns durable audit. */ }
    return result;
  } catch { return failure({ code: "unavailable" }); }
}
/** Snap has no verified create idempotency; incomplete/ambiguous receipts never authorize resending. */
function receipt(required: { references: References; hierarchy?: unknown[]; status?: SnapchatDeploymentResult["status"] }): Outcome<SnapchatDeploymentResult> {
  return { ok: true, value: { status: required.status ?? "unknown", references: { ...required.references }, entityIds: Object.values(required.references), hierarchy: required.hierarchy ?? [] } };
}
