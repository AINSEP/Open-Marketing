import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { callContextSchema, epochSchema, idSchema, digestSchema, scopeSchema } from "@open-marketing/contracts";
import type { CallContext, CallOptions, Outcome } from "@open-marketing/contracts";
import { failure, loginSchema, providerId, vendorId } from "./commands.js";
import { campaignDeploymentPlanSchema } from "./campaign-translation.js";
import type { YandexDirectDependencies } from "./transport.js";

const steps = ["campaign", "group", "ad"] as const;
type Step = typeof steps[number];
const referencesSchema = z.strictObject({ campaign: vendorId.optional(), group: vendorId.optional(), ad: vendorId.optional() });
type References = z.infer<typeof referencesSchema>;
/** Partial references survive every uncertain dispatch/checkpoint/read; acknowledged requires all reads. */
export interface YandexDeploymentResult { status: "acknowledged" | "unknown"; references: References; entityIds: string[]; hierarchy: unknown[] }
/** Existing jobs checkpoint ABI: host atomically rejects duplicate dispatch intents, including restarts.
 * Host fetch MUST recheck current grouped-card authority, scope/login and halt after token lookup,
 * hold that fence through egress and append the audit. No nested gateway or plugin outbox. */
export interface YandexDeploymentInput {
  context: CallContext; operationId: string; plan: unknown; dependencies: Omit<YandexDirectDependencies, "gateway">;
  checkpoint: (required: { step: string; phase: "dispatch" | "acknowledged"; references: References }) => Promise<Outcome<void>>;
}
/** Recovery accepts only saved IDs, never names or a continuation cursor. */
export type YandexDeploymentReadInput = Omit<YandexDeploymentInput, "checkpoint"> & { references: unknown };
const configurationSchema = z.strictObject({ scope: scopeSchema, connectionId: idSchema, accountId: vendorId, clientLogin: loginSchema, currency: z.string().regex(/^[A-Z]{3}$/), apiVersion: z.literal("v501"), pluginDigest: digestSchema, bindingId: idSchema });
const inputSchema = z.strictObject({ context: callContextSchema, operationId: idSchema, plan: campaignDeploymentPlanSchema, configuration: configurationSchema });
type Checked = z.infer<typeof inputSchema> & Pick<YandexDeploymentInput, "dependencies">;
const credentialSchema = z.strictObject({ accessToken: z.string().min(1).max(4096).regex(/^[\x21-\x7e]+$/), expiresAt: epochSchema.optional() });
const services = { campaign: "campaigns", group: "adgroups", ad: "ads" };
const collections = { campaign: "Campaigns", group: "AdGroups", ad: "Ads" };
const strategy = campaignDeploymentPlanSchema.shape.campaign.shape.UnifiedCampaign.shape.BiddingStrategy;
const campaignRow = z.object({ ...campaignDeploymentPlanSchema.shape.campaign.shape, Id: providerId, Type: z.literal("UNIFIED_CAMPAIGN"), Status: z.literal("DRAFT"), State: z.literal("OFF"),
  UnifiedCampaign: z.object({ BiddingStrategy: z.object({ Search: strategy.shape.Search.strip().extend({ WbMaximumClicks: strategy.shape.Search.shape.WbMaximumClicks.strip() }), Network: strategy.shape.Network.strip() }) }) });
const groupRow = z.object({ ...campaignDeploymentPlanSchema.shape.group.shape, Id: providerId, CampaignId: providerId.transform(Number), UnifiedAdGroup: z.object({ OfferRetargeting: z.literal("NO") }) });
const adRow = z.object({ Id: providerId, CampaignId: providerId.transform(Number), AdGroupId: providerId.transform(Number), Status: z.literal("DRAFT"), State: z.literal("OFF"), ResponsiveAd: z.object({
  Titles: z.tuple([z.object({ Title: z.string().max(56) })]).transform(items => items.map(item => item.Title)),
  Texts: z.tuple([z.object({ Text: z.string().max(81) })]).transform(items => items.map(item => item.Text)), Href: z.string().max(1024),
}) });

/** One checkpointed campaign -> group -> ad sequence inside the existing approved job.
 * @param required - Frozen plan, injected guarded I/O and durable checkpoints.
 * @returns Verified DRAFT receipt or unknown retaining every known ID; no retries/rollback.
 * @complexity O(b) bounded parsing; <=3 creates, <=6 scoped reads plus identity verification.
 */
export async function deployCampaignPaused(required: YandexDeploymentInput, optional?: CallOptions): Promise<Outcome<YandexDeploymentResult>> {
  const checked = checkInput({ input: required });
  if (!checked.ok) return checked;
  const input = checked.value;
  const references: References = {};
  if (!await verifyAccount({ input }, optional)) return receipt({ references });
  for (const step of steps) {
    const complete = await createStep({ input, step, references, checkpoint: required.checkpoint }, optional);
    if (!complete) return receipt({ references });
  }
  return reconcile({ input, references }, optional);
}
/** Saved-ID, read-only reconciliation; no create retries or automatic continuation.
 * @returns Unknown with partial refs on any absent/mismatched row; no discovery/name scans.
 * @complexity O(b), at most identity + three single-ID reads, each <=15s/1MiB.
 */
export async function readCampaignDeployment(required: YandexDeploymentReadInput, optional?: CallOptions): Promise<Outcome<YandexDeploymentResult>> {
  const checked = checkInput({ input: required });
  if (!checked.ok) return checked;
  const refs = referencesSchema.safeParse(required.references);
  if (!refs.success) return failure({ code: "invalid_input" });
  if (!await verifyAccount({ input: checked.value }, optional)) return receipt({ references: refs.data });
  return reconcile({ input: checked.value, references: refs.data }, optional);
}
/** Bounded snapshot before async work; admission faults return unavailable before secrets. O(b<=64KiB). */
function checkInput(required: { input: Omit<YandexDeploymentInput, "checkpoint"> }): Outcome<Checked> {
  const { input } = required;
  try {
    if (!input.dependencies.admitted()) return failure({ code: "forbidden" });
  } catch { return failure({ code: "unavailable" }); }
  try {
    const serialized = JSON.stringify({ context: input.context, operationId: input.operationId, plan: input.plan, configuration: input.dependencies.configuration });
    if (Buffer.byteLength(serialized) > 65536) return failure({ code: "limit_exceeded" });
    const parsed = inputSchema.safeParse(JSON.parse(serialized));
    if (!parsed.success) return failure({ code: "invalid_input" });
    const { configuration, plan, context } = parsed.data;
    if (!isDeepStrictEqual(context.scope, configuration.scope)) return failure({ code: "forbidden" });
    if (plan.accountId !== configuration.accountId || plan.clientLogin !== configuration.clientLogin || plan.currency !== configuration.currency) return failure({ code: "conflict" });
    return { ok: true, value: { ...parsed.data, dependencies: input.dependencies } };
  } catch { return failure({ code: "invalid_input" }); }
}
/** Persist intent then candidate ID; a failed checkpoint/read always stops before the next child. O(1). */
async function createStep(required: { input: Checked; step: Step; references: References; checkpoint: YandexDeploymentInput["checkpoint"] }, optional?: CallOptions): Promise<boolean> {
  const { input, step, references } = required;
  if (!await checkpoint({ ...required, phase: "dispatch" })) return false;
  const result = await send({ input, service: services[step], method: "add", params: { [collections[step]]: [payload(required)] } }, optional);
  if (!result.ok) return false;
  const ack = z.object({ AddResults: z.tuple([z.object({ Id: providerId })]) }).safeParse(result.value);
  if (!ack.success) return false;
  references[step] = ack.data.AddResults[0].Id;
  if (!await checkpoint({ ...required, phase: "acknowledged" })) return false;
  const noErrors = z.object({ AddResults: z.tuple([z.object({ Errors: z.array(z.never()).optional() })]) }).safeParse(result.value);
  if (!noErrors.success) return false;
  return (await readStep({ input, step, references }, optional)).ok;
}
/** Copy references across the host boundary, redact thrown storage faults. O(1), one append. */
async function checkpoint(required: { checkpoint: YandexDeploymentInput["checkpoint"]; step: Step; phase: "dispatch" | "acknowledged"; references: References }): Promise<boolean> {
  try { return (await required.checkpoint({ step: required.step, phase: required.phase, references: { ...required.references } })).ok; }
  catch { return false; }
}
/** Substitute only acknowledged parents; all other approved bytes stay fixed. O(1), pure. */
function payload(required: { input: Checked; step: Step; references: References }): object {
  const { plan } = required.input;
  switch (required.step) {
    case "campaign": return plan.campaign;
    case "group": return { ...plan.group, CampaignId: Number(required.references.campaign) };
    case "ad": return { ...plan.ad, AdGroupId: Number(required.references.group) };
    default: { const exhaustive: never = required.step; return exhaustive; }
  }
}
/** Re-read known parents in order even when a later ID is missing; never continue creating. O(1) calls. */
async function reconcile(required: { input: Checked; references: References }, optional?: CallOptions): Promise<Outcome<YandexDeploymentResult>> {
  const hierarchy: unknown[] = [];
  for (const step of steps) {
    const row = await readStep({ ...required, step }, optional);
    if (!row.ok) return receipt({ references: required.references, hierarchy });
    hierarchy.push(row.value);
  }
  return receipt({ references: required.references, hierarchy, status: "acknowledged" });
}
const fields = { campaign: ["Id", "Name", "Type", "Status", "State", "StartDate", "EndDate", "TimeZone"], group: ["Id", "Name", "CampaignId", "RegionIds"], ad: ["Id", "CampaignId", "AdGroupId", "Status", "State"] };
/** Require one exact ID, correct parents, DRAFT/OFF and approved normalized content. O(b<=1MiB). */
async function readStep(required: { input: Checked; step: Step; references: References }, optional?: CallOptions): Promise<Outcome<unknown>> {
  const { step, references } = required;
  const id = references[step];
  if (!id) return failure({ code: "protocol_mismatch" });
  const extensions = { campaign: { UnifiedCampaignFieldNames: ["BiddingStrategy"] }, group: { UnifiedAdGroupFieldNames: ["OfferRetargeting"] }, ad: { ResponsiveAdFieldNames: ["Titles", "Texts", "Href"] } };
  const result = await send({ input: required.input, service: services[step], method: "get", params: { SelectionCriteria: { Ids: [Number(id)] }, FieldNames: fields[step], ...extensions[step], Page: { Limit: 1, Offset: 0 } } }, optional);
  if (!result.ok) return result;
  const envelope = z.object({ [collections[step]]: z.tuple([z.unknown()]), LimitedBy: z.never().optional() }).safeParse(result.value);
  if (!envelope.success) return failure({ code: "protocol_mismatch" });
  const row = { campaign: campaignRow, group: groupRow, ad: adRow }[step].safeParse(envelope.data[collections[step]]![0]);
  if (!row.success || row.data.Id !== id) return failure({ code: "protocol_mismatch" });
  const expected = payload(required);
  if (!Object.entries(expected).every(([key, value]) => isDeepStrictEqual((row.data as Record<string, unknown>)[key], value))) return failure({ code: "protocol_mismatch" });
  if (step === "ad" && (row.data as { CampaignId: number }).CampaignId !== Number(references.campaign)) return failure({ code: "protocol_mismatch" });
  return { ok: true, value: { ...row.data, accountId: required.input.configuration.accountId } };
}
/** Validate the currently bound representative with Client-Login; campaign rows have no account ID. */
async function verifyAccount(required: { input: Checked }, optional?: CallOptions): Promise<boolean> {
  const result = await send({ input: required.input, service: "clients", method: "get", params: { FieldNames: ["ClientId", "Login", "Currency"] } }, optional);
  if (!result.ok) return false;
  const row = z.object({ Clients: z.tuple([z.object({ ClientId: providerId, Login: loginSchema, Currency: z.string() })]) }).safeParse(result.value);
  if (!row.success) return false;
  const { configuration } = required.input;
  return isDeepStrictEqual(row.data.Clients[0], { ClientId: configuration.accountId, Login: configuration.clientLogin, Currency: configuration.currency });
}
/** Fresh credentials then final admission and host guarded fetch. No retry or token retention.
 * O(b) time/space, one request <=15s, body <=1MiB; caller cancellation covers all reads. */
async function send(required: { input: Checked; service: string; method: "add" | "get"; params: object }, optional?: CallOptions): Promise<Outcome<unknown>> {
  const { dependencies, configuration } = required.input;
  try {
    if (!dependencies.admitted()) return failure({ code: "forbidden" });
    if (optional?.signal?.aborted) return failure({ code: "cancelled" });
    const resolved = await dependencies.credentials.access({ connectionId: configuration.connectionId, accountId: configuration.accountId }, optional);
    if (!resolved.ok) return failure({ code: resolved.error.code });
    if (!dependencies.admitted()) return failure({ code: "forbidden" });
    if (optional?.signal?.aborted) return failure({ code: "cancelled" });
    const credential = checkCredential({ value: resolved.value, now: dependencies.clock.now({}) });
    if (!credential.ok) return credential;
    const deadline = dependencies.createDeadline({ milliseconds: 15000 });
    const signal = optional?.signal ? AbortSignal.any([deadline, optional.signal]) : deadline;
    const response = await dependencies.fetch("https://api.direct.yandex.com/json/v501/" + required.service, { method: "POST", redirect: "error", signal,
      headers: { "Content-Type": "application/json; charset=utf-8", "Accept-Language": "en", "Client-Login": configuration.clientLogin, Authorization: "Bearer " + credential.value.accessToken }, body: JSON.stringify({ method: required.method, params: required.params }) });
    return await decodeResponse({ response });
  } catch { return failure({ code: optional?.signal?.aborted ? "cancelled" : "unavailable" }); }
  finally { observe({ input: required.input, operation: required.method + "." + required.service }); }
}
/** Tainted broker output and injected clock must validate before egress; no secret in failures. O(1). */
function checkCredential(required: { value: unknown; now: number }): Outcome<z.infer<typeof credentialSchema>> {
  const parsed = credentialSchema.safeParse(required.value);
  if (!parsed.success) return failure({ code: "unauthenticated" });
  if (!epochSchema.safeParse(required.now).success) return failure({ code: "invalid_input" });
  if (parsed.data.expiresAt !== undefined && required.now >= parsed.data.expiresAt) return failure({ code: "expired" });
  return { ok: true, value: parsed.data };
}
/** Bound streamed JSON before trusting the vendor result; HTTP-200 errors remain failures. O(b). */
async function decodeResponse(required: { response: Response }): Promise<Outcome<unknown>> {
  const { response } = required;
  if (response.status !== 200 || !response.body) { await response.body?.cancel(); return failure({ code: "unavailable" }); }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > 1048576) { await reader.cancel(); return failure({ code: "limit_exceeded" }); }
      chunks.push(chunk.value);
    }
  } finally { reader.releaseLock(); }
  const body: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
  const envelope = z.object({ result: z.unknown(), error: z.never().optional() }).safeParse(body);
  return envelope.success && envelope.data.result !== undefined ? { ok: true, value: envelope.data.result } : failure({ code: "protocol_mismatch" });
}
/** Correlated attempt metadata only; authoritative outcome/egress audit belongs to host checkpoints. */
function observe(required: { input: Checked; operation: string }): void {
  const { context, dependencies } = required.input;
  try { dependencies.observer.observe({ operation: "yandex-direct.deployment." + required.operation, outcome: "finished", correlationId: context.correlationId, traceId: context.traceId, runId: context.runId }); }
  catch { /* Telemetry cannot erase returned IDs. */ }
}
function receipt(required: { references: References; hierarchy?: unknown[]; status?: YandexDeploymentResult["status"] }): Outcome<YandexDeploymentResult> {
  return { ok: true, value: { status: required.status ?? "unknown", references: { ...required.references }, entityIds: Object.values(required.references), hierarchy: required.hierarchy ?? [] } };
}
