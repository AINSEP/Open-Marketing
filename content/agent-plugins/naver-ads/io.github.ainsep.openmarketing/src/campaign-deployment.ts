import { createHmac } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { callContextSchema, epochSchema, idSchema, scopeSchema } from "@open-marketing/contracts";
import type { AppError, CallContext, CallOptions, Outcome } from "@open-marketing/contracts";
import { customerIdSchema } from "./commands.js";
import { campaignDeploymentPlanSchema, pausedLaunchUnavailableReason } from "./campaign-translation.js";
import type { NaverPausedPlan } from "./campaign-translation.js";
import { readBody, type NaverDependencies } from "./transport.js";

export { campaignDeploymentPlanSchema } from "./campaign-translation.js";
const slotSchema = z.string().regex(/^(campaign|adgroup|ad|keyword_([0-9]|1[0-9]))$/);
const vendorId = z.string().regex(/^(cmp|grp|nad|nkw)-[A-Za-z0-9-]{1,120}$/);
const referencesSchema = z.record(slotSchema, vendorId).refine(value => new Set(Object.values(value)).size === Object.keys(value).length);
type References = z.infer<typeof referencesSchema>;
/** Flat saved references fit the existing campaign journal; missing IDs always remain unknown. */
export interface NaverDeploymentResult { status: "acknowledged" | "unknown"; references: References; entityIds: string[]; hierarchy: unknown[] }
interface Input { context: CallContext; operationId: string; plan: unknown; dependencies: NaverDependencies }
/** The host's ONE outbox owns checkpoints and duplicate suppression; this run performs no creates. */
export type NaverDeploymentCheckpoint = (input: { step: string; phase: "dispatch" | "acknowledged"; references: References }) => Promise<Outcome<void>>;
const configurationSchema = z.strictObject({ scope: scopeSchema, connectionId: idSchema, accountId: customerIdSchema, credentialCustomerId: customerIdSchema, admitted: z.boolean() });
const inputSchema = z.strictObject({ context: callContextSchema, operationId: idSchema, plan: campaignDeploymentPlanSchema, configuration: configurationSchema, references: referencesSchema });
type Checked = z.infer<typeof inputSchema> & Pick<Input, "dependencies">;
const secret = z.string().min(1).max(4096).regex(/^[\x21-\x7e]+(?![\s\S])/);
const credentialSchema = z.strictObject({ apiKey: secret, secretKey: secret, customerId: customerIdSchema });
const rowSchema = z.object({ customerId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), userLock: z.literal(true), status: z.literal("PAUSED") }).catchall(z.unknown());

/** Typed denial before checkpoint/credentials/POST, even for a caller-crafted paused plan.
 * The integrator must close the documented prerequisites before implementing creation.
 * @complexity O(1) time/space; zero I/O, retries, activation or compensation.
 */
export async function deployCampaignPaused(required: Input & { checkpoint: NaverDeploymentCheckpoint }, optional?: CallOptions): Promise<Outcome<NaverDeploymentResult>> {
  if (required.dependencies.configuration.admitted !== true) return failure({ code: "forbidden" });
  if (optional?.signal?.aborted) return failure({ code: "cancelled" });
  return { ok: false, error: { code: "not_implemented", message: pausedLaunchUnavailableReason, retryable: false } };
}

/** Verify saved refs with GETs only; read parents before children and stop on any uncertainty.
 * Every returned receipt retains all validated refs, including later/partial keyword IDs.
 * @example readCampaignDeployment({ context, operationId, plan, references, dependencies })
 * @complexity O(n*b) time, O(n+b) space; n<=24 scoped GETs, each <=15s and <=1MiB.
 */
export async function readCampaignDeployment(required: Input & { references: unknown }, optional?: CallOptions): Promise<Outcome<NaverDeploymentResult>> {
  const checked = checkInput({ input: required });
  if (!checked.ok) return checked;
  const input = checked.value;
  const references = input.references;
  const hierarchy: unknown[] = [];
  const slots = ["campaign", "adgroup", "ad", ...input.plan.keywords.map((_, index) => "keyword_" + index)];
  for (const slot of slots) {
    if (!references[slot]) return receipt({ references, hierarchy });
    const row = await readStep({ input, slot, references }, optional);
    if (!row.ok) return receipt({ references, hierarchy });
    hierarchy.push(row.value);
  }
  if (Object.keys(references).length !== slots.length) return receipt({ references, hierarchy });
  const channel = await readChannel({ input }, optional);
  if (!channel.ok) return receipt({ references, hierarchy });
  hierarchy.push(channel.value);
  return receipt({ references, hierarchy, status: "acknowledged" });
}

/** Bound the complete frozen intent and account scope before any credential access. O(b), <=64KiB. */
function checkInput(required: { input: Input & { references: unknown } }): Outcome<Checked> {
  const input = required.input;
  if (input.dependencies.configuration.admitted !== true) return failure({ code: "forbidden" });
  try {
    const json = JSON.stringify({ context: input.context, operationId: input.operationId, plan: input.plan, configuration: input.dependencies.configuration, references: input.references });
    if (Buffer.byteLength(json) > 65536) return failure({ code: "limit_exceeded" });
    const parsed = inputSchema.safeParse(JSON.parse(json));
    if (!parsed.success) return failure({ code: "invalid_input" });
    const { context, configuration, plan } = parsed.data;
    if (!isDeepStrictEqual(context.scope, configuration.scope) || plan.accountId !== configuration.accountId || plan.credentialCustomerId !== configuration.credentialCustomerId) return failure({ code: "forbidden" });
    return { ok: true, value: { ...parsed.data, dependencies: input.dependencies } };
  } catch { return failure({ code: "invalid_input" }); }
}

/** Verify the frozen existing SITE channel's identity and ownership before acknowledging. One GET. */
async function readChannel(required: { input: Checked }, optional?: CallOptions): Promise<Outcome<unknown>> {
  const input = required.input;
  const response = await sendGet({ input, path: "/ncc/channels/" + encodeURIComponent(input.plan.channelId) }, optional);
  if (!response.ok) return response;
  const parsed = z.object({ nccBusinessChannelId: z.literal(input.plan.channelId), channelTp: z.literal("SITE"), customerId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) }).safeParse(response.value);
  if (!parsed.success || String(parsed.data.customerId) !== input.configuration.accountId) return failure({ code: "protocol_mismatch" });
  return { ok: true, value: parsed.data };
}

/** Fixed paths and expected controls; parent IDs come only from saved references. No discovery scan. */
function expectedRow(required: { plan: NaverPausedPlan; references: References; slot: string }) {
  const { plan, references, slot } = required;
  switch (slot) {
    case "campaign": return { path: "/ncc/campaigns/", idField: "nccCampaignId", prefix: "cmp-", controls: plan.campaign };
    case "adgroup": return { path: "/ncc/adgroups/", idField: "nccAdgroupId", prefix: "grp-", controls: { ...plan.adgroup, nccCampaignId: references.campaign, pcChannelId: plan.channelId, mobileChannelId: plan.channelId } };
    case "ad": return { path: "/ncc/ads/", idField: "nccAdId", prefix: "nad-", controls: { ...plan.ad, nccAdgroupId: references.adgroup } };
    default: return { path: "/ncc/keywords/", idField: "nccKeywordId", prefix: "nkw-", controls: { ...plan.keywords[Number(slot.slice(8))], nccAdgroupId: references.adgroup } };
  }
}

/** Parse vendor JSON before comparing every saved control, parent, ownership and explicit pause. O(b). */
async function readStep(required: { input: Checked; slot: string; references: References }, optional?: CallOptions): Promise<Outcome<unknown>> {
  const { input, slot, references } = required;
  const expected = expectedRow({ plan: input.plan, references, slot });
  const id = references[slot]!;
  if (!id.startsWith(expected.prefix)) return failure({ code: "invalid_input" });
  const response = await sendGet({ input, path: expected.path + encodeURIComponent(id) }, optional);
  if (!response.ok) return response;
  const parsed = rowSchema.safeParse(response.value);
  if (!parsed.success || String(parsed.data.customerId) !== input.configuration.accountId || parsed.data[expected.idField] !== id) return failure({ code: "protocol_mismatch" });
  try {
    const row = parsed.data;
    if (slot === "ad" && typeof row.ad === "string") row.ad = JSON.parse(row.ad) as unknown;
    if (!Object.entries(expected.controls).every(([key, value]) => isDeepStrictEqual(row[key], value))) return failure({ code: "protocol_mismatch" });
    return { ok: true, value: { ...expected.controls, customerId: row.customerId, [expected.idField]: id, status: "PAUSED" } };
  } catch { return failure({ code: "protocol_mismatch" }); }
}

/** Readback uses R1's injected broker/fetch contract, fresh keys and path-only HMAC.
 * Host fetch MUST recheck admission/account/halt/policy and audit context IDs every dispatch.
 * @complexity One bounded broker access and GET; no retries or retained credentials.
 */
async function sendGet(required: { input: Checked; path: string }, optional?: CallOptions): Promise<Outcome<unknown>> {
  const { input, path } = required;
  const { dependencies, configuration } = input;
  if (optional?.signal?.aborted) return failure({ code: "cancelled" });
  if (!isDeepStrictEqual(dependencies.configuration, configuration)) return failure({ code: "forbidden" });
  let result: Outcome<unknown>;
  try { result = await authenticatedGet({ input, path }, optional); }
  catch { result = failure({ code: "unavailable" }); }
  try { dependencies.observer.observe({ operation: "naver-ads.deployment.readback", outcome: result.ok ? "received" : result.error.code, correlationId: input.context.correlationId, traceId: input.context.traceId, runId: input.context.runId }); }
  catch { /* Telemetry cannot erase a validated read or change saved references. */ }
  return result.ok ? result : failure({ code: result.error.code });
}

/** Recheck the frozen binding after credential access; vendor/broker messages never leave this boundary. */
async function authenticatedGet(required: { input: Checked; path: string }, optional?: CallOptions): Promise<Outcome<unknown>> {
  const { input, path } = required;
  const { dependencies, configuration } = input;
  const access = await dependencies.credentials.access({ connectionId: configuration.connectionId, accountId: configuration.accountId }, optional);
  if (!access.ok) return failure({ code: access.error.code });
  if (Buffer.byteLength(access.value.accessToken) > 16384) return failure({ code: "unauthenticated" });
  const credential = credentialSchema.safeParse(JSON.parse(access.value.accessToken));
  if (!credential.success || credential.data.customerId !== configuration.credentialCustomerId) return failure({ code: "unauthenticated" });
  if (!isDeepStrictEqual(dependencies.configuration, configuration)) return failure({ code: "forbidden" });
  if (optional?.signal?.aborted) return failure({ code: "cancelled" });
  const now = dependencies.clock.now({});
  if (!epochSchema.safeParse(now).success) return failure({ code: "invalid_input" });
  const signature = createHmac("sha256", credential.data.secretKey).update(`${now}.GET.${path}`).digest("base64");
  const deadline = dependencies.createDeadline({ timeoutMs: 15000 });
  const signal = optional?.signal ? AbortSignal.any([deadline, optional.signal]) : deadline;
  const response = await dependencies.fetch("https://api.searchad.naver.com" + path, { method: "GET", redirect: "error", signal,
    headers: { "X-Timestamp": String(now), "X-API-KEY": credential.data.apiKey, "X-Customer": configuration.accountId, "X-Signature": signature } });
  if (response.status !== 200) { await response.body?.cancel(); return failure({ code: "unavailable" }); }
  const body = await readBody({ response });
  if (signal.aborted) return failure({ code: "cancelled" });
  return body;
}

function receipt(required: { references: References; hierarchy: unknown[]; status?: NaverDeploymentResult["status"] }): Outcome<NaverDeploymentResult> {
  return { ok: true, value: { ...required, status: required.status ?? "unknown", references: { ...required.references }, entityIds: Object.values(required.references) } };
}
function failure(required: { code: AppError["code"] }): Outcome<never> { return { ok: false, error: { code: required.code, message: "Naver deployment readback failed", retryable: false } }; }
