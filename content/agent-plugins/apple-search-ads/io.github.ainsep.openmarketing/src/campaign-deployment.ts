import { z } from "zod";
import { isDeepStrictEqual } from "node:util";
import { callContextSchema, epochSchema, idSchema } from "@open-marketing/contracts";
import type { CallContext, CallOptions, Outcome } from "@open-marketing/contracts";
import { failure, moneySchema, responseIdSchema, vendorIdSchema } from "./commands.js";
import type { AppleRequest } from "./commands.js";
import { adBodySchema, adgroupBodySchema, campaignBodySchema, campaignDeploymentPlanSchema, decimalUnits, snapshot } from "./campaign-translation.js";
import { configurationSchema, resolveCredential, send as transport } from "./transport.js";
import type { AppleSearchAdsDependencies } from "./transport.js";
export { campaignDeploymentPlanSchema } from "./campaign-translation.js";

const base = "https://api.ads.apple.com/v1";
const steps = ["campaign", "adgroup", "ad"] as const;
type Step = typeof steps[number];
const referencesSchema = z.strictObject({ campaign: vendorIdSchema.optional(), adgroup: vendorIdSchema.optional(), ad: vendorIdSchema.optional() });
type References = z.infer<typeof referencesSchema>;
/** Matches the owning OM campaign job receipt; unknown always retains validated candidate IDs. */
export interface AppleSearchAdsDeploymentResult { status: "acknowledged" | "unknown"; entityIds: string[]; references: References; hierarchy: unknown[] }
type Checkpoint = (input: { step: string; phase: "dispatch" | "acknowledged"; references: References }) => Promise<Outcome<void>>;
interface Input { context: CallContext; operationId: string; plan: unknown; dependencies: AppleSearchAdsDependencies; checkpoint: Checkpoint }
const inputSchema = z.strictObject({ context: callContextSchema, operationId: idSchema, configuration: configurationSchema, plan: campaignDeploymentPlanSchema });
type Checked = z.infer<typeof inputSchema> & Pick<Input, "dependencies">;
// Apple examples omit the UTC suffix; accept that documented representation, never local time.
const wireTime = z.string().max(24).transform(value => value.endsWith("Z") ? value : value + "Z").pipe(z.iso.datetime()).transform(value => new Date(value).toISOString());
const wireMoney = moneySchema.transform(value => ({ units: decimalUnits({ amount: value.amount }).toString(), currency: value.currency }));
const stopped = { id: responseIdSchema, adAccountId: responseIdSchema, status: z.literal("PAUSED"), systemStatus: z.literal("NOT_RUNNING"), deleted: z.literal(false) };
const reads = {
  campaign: campaignBodySchema.strip().extend({ ...stopped, startTime: wireTime, endTime: wireTime, dailyBudget: z.object({ value: wireMoney }),
    targeting: z.object({ ...campaignBodySchema.shape.targeting.shape,
      countryOrRegion: z.object({ include: campaignBodySchema.shape.targeting.shape.countryOrRegion.shape.include.transform(values => values.slice().sort()) }) }) }),
  adgroup: adgroupBodySchema.strip().extend({ ...stopped, campaignId: responseIdSchema, startTime: wireTime, endTime: wireTime,
    bidStrategy: z.object({ ...adgroupBodySchema.shape.bidStrategy.shape, bid: wireMoney }) }),
  ad: adBodySchema.strip().extend({ ...stopped, campaignId: responseIdSchema, adGroupId: responseIdSchema, creativeId: responseIdSchema }),
};
const creativeSchema = z.object({ id: responseIdSchema, adAccountId: responseIdSchema, destination: z.object({ destinationType: z.literal("APP_STORE_PRODUCT_PAGE"), parameters: z.object({ adamId: responseIdSchema }) }), systemStatus: z.literal("VALID"), deleted: z.literal(false) });

/** Execute inside the ONE approved host job/card. Checkpoint before each create and verify each
 * parent before its child. Host checkpoints MUST reject repeated dispatch intents across restarts.
 * @param required - Frozen plan, guarded dependencies and durable checkpoint callback.
 * @returns Complete non-serving hierarchy or unknown retaining IDs; never activates/retries/rolls back.
 * @example deployCampaignPaused({ context, operationId, plan, dependencies, checkpoint })
 * @complexity <=3 creates +4 GETs, each <=15s/1MiB; O(b) response validation.
 */
export async function deployCampaignPaused(required: Input, optional?: CallOptions): Promise<Outcome<AppleSearchAdsDeploymentResult>> {
  const checked = checkInput({ input: required });
  if (!checked.ok) return checked;
  const input = { ...checked.value, checkpoint: required.checkpoint };
  if (!futureStart({ input })) return failure({ code: "invalid_input" });
  const preflight = await send({ input, request: { url: base + "/creatives/" + input.plan.ad.creativeId, method: "GET" } }, optional);
  if (!preflight.ok) return preflight;
  const creative = decodeRow({ body: preflight.value, schema: creativeSchema });
  if (!creative.ok || !isDeepStrictEqual(creative.value, { id: String(input.plan.ad.creativeId), adAccountId: input.configuration.accountId, destination: { destinationType: "APP_STORE_PRODUCT_PAGE", parameters: { adamId: input.plan.campaign.promotedObjectId } }, systemStatus: "VALID", deleted: false })) return failure({ code: "protocol_mismatch" });
  const references: References = {};
  const hierarchy: unknown[] = [];
  for (const step of steps) {
    if (!await createStep({ input, step, references }, optional)) return receipt({ references, hierarchy });
    const row = await readStep({ input, step, references }, optional);
    if (!row.ok) return receipt({ references, hierarchy });
    hierarchy.push(row.value);
  }
  return receipt({ references, hierarchy, status: "acknowledged" });
}

/** GET-only saved-ID reconciliation; no scan, create, retry or automatic continuation.
 * @param required - Original plan, scoped dependencies and saved references.
 * @returns Acknowledged only for a complete matching PAUSED/non-serving hierarchy, else unknown.
 * @example readCampaignDeployment({ context, operationId, plan, dependencies, references })
 * @complexity <=3 bounded GETs, O(b) validation; missing IDs stop without discovery.
 */
export async function readCampaignDeployment(required: Omit<Input, "checkpoint"> & { references: unknown }, optional?: CallOptions): Promise<Outcome<AppleSearchAdsDeploymentResult>> {
  const checked = checkInput({ input: required });
  if (!checked.ok) return checked;
  const frozen = snapshot({ input: required.references });
  if (!frozen.ok) return frozen;
  const refs = referencesSchema.safeParse(frozen.value);
  if (!refs.success) return failure({ code: "invalid_input" });
  const hierarchy: unknown[] = [];
  for (const step of steps) {
    const row = await readStep({ input: checked.value, step, references: refs.data }, optional);
    if (!row.ok) return receipt({ references: refs.data, hierarchy });
    hierarchy.push(row.value);
  }
  return receipt({ references: refs.data, hierarchy, status: "acknowledged" });
}

/** Candidate ID is retained before acknowledged checkpoint/readback, even if later evidence fails. O(1) I/O. */
async function createStep(required: { input: Checked & Pick<Input, "checkpoint">; step: Step; references: References }, optional?: CallOptions): Promise<boolean> {
  const { input, step, references } = required;
  // Flat v1 creates put parent IDs in JSON; never round a retained string ID.
  if (Object.values(references).some(id => !Number.isSafeInteger(Number(id)))) return false;
  if (optional?.signal?.aborted || !await checkpoint({ input, step, phase: "dispatch", references })) return false;
  const request = creationRequest(required);
  const response = await send({ input, request }, optional);
  if (!response.ok) return false;
  const ack = decodeRow({ body: response.value, schema: z.object({ id: responseIdSchema }) });
  if (!ack.ok) return false;
  references[step] = ack.value.id;
  return checkpoint({ input, step, phase: "acknowledged", references });
}

/** Validate scoped parent IDs, complete approved configuration and independent non-serving evidence. O(b). */
async function readStep(required: { input: Checked; step: Step; references: References }, optional?: CallOptions): Promise<Outcome<unknown>> {
  const { input, step, references } = required;
  const id = references[step];
  if (!id || (step !== "campaign" && !references.campaign) || (step === "ad" && !references.adgroup)) return failure({ code: "protocol_mismatch" });
  const create = creationRequest(required);
  const response = await send({ input, request: { url: create.url + "/" + id, method: "GET" } }, optional);
  if (!response.ok) return response;
  const parents = step === "ad" ? { campaignId: references.campaign, adGroupId: references.adgroup } : {};
  const expected: Record<string, unknown> = { ...JSON.parse(create.body!), ...parents, id, adAccountId: input.configuration.accountId, systemStatus: "NOT_RUNNING", deleted: false };
  if (step === "adgroup") expected.campaignId = references.campaign;
  const schema = reads[step] as z.ZodType<unknown>;
  const row = decodeRow({ body: response.value, schema });
  const normalized = schema.safeParse(expected);
  if (!row.ok || !normalized.success || !isDeepStrictEqual(row.value, normalized.data)) return failure({ code: "protocol_mismatch" });
  return { ok: true, value: expected };
}

/** Snapshot and validate all plan/configuration fields before checkpoints, credentials or network. O(b<=64KiB). */
function checkInput(required: { input: Omit<Input, "checkpoint"> }): Outcome<Checked> {
  const input = required.input;
  if (input.dependencies.admitted !== true) return failure({ code: "forbidden" });
  const frozen = snapshot({ input: { context: input.context, operationId: input.operationId, configuration: input.dependencies.configuration, plan: input.plan } });
  if (!frozen.ok) return frozen;
  const parsed = inputSchema.safeParse(frozen.value);
  if (!parsed.success) return failure({ code: "not_implemented" });
  const { configuration, context, plan } = parsed.data;
  if (!isDeepStrictEqual(context.scope, configuration.scope) || configuration.accountId !== String(plan.campaign.adAccountId)) return failure({ code: "forbidden" });
  if (configuration.currency !== plan.campaign.dailyBudget.value.currency) return failure({ code: "conflict" });
  return { ok: true, value: { ...parsed.data, dependencies: input.dependencies } };
}

/** Fixed paths and two numeric parent substitutions; payloads stay as approved. O(b<=64KiB), no I/O. */
function creationRequest(required: { input: Checked; step: Step; references: References }): AppleRequest {
  const { plan } = required.input;
  const { campaignId: _campaignSlot, ...adgroup } = plan.adgroup;
  const { adgroupId: _groupSlot, ...ad } = plan.ad;
  const paths = { campaign: "/campaigns", adgroup: "/adgroups", ad: "/ads" };
  const bodies = { campaign: plan.campaign, adgroup: { ...adgroup, campaignId: Number(required.references.campaign) }, ad: { ...ad, adGroupId: Number(required.references.adgroup) } };
  return { url: base + paths[required.step], method: "POST", body: JSON.stringify(bodies[required.step]) };
}

/** Only v1 result envelopes are valid; bare objects and legacy data cannot acknowledge a create. O(b). */
function decodeRow<T>(required: { body: unknown; schema: z.ZodType<T> }): Outcome<T> {
  const shell = z.object({ result: required.schema, error: z.null().optional() }).safeParse(required.body);
  return shell.success ? { ok: true, value: shell.data.result } : failure({ code: "protocol_mismatch" });
}

/** Durable host callback receives isolated references; thrown or denied appends stop immediately. O(1). */
async function checkpoint(required: { input: Checked & Pick<Input, "checkpoint">; step: Step; phase: "dispatch" | "acknowledged"; references: References }): Promise<boolean> {
  try { return (await required.input.checkpoint({ step: required.step, phase: required.phase, references: { ...required.references } })).ok; }
  catch { return false; }
}

/** Fresh credentials per request; reuse R1 bounds and host final egress fence, never a second policy/outbox. O(b). */
async function send(required: { input: Checked; request: AppleRequest }, optional?: CallOptions): Promise<Outcome<unknown>> {
  const { input } = required;
  try {
    const before = dispatchAllowed(required, optional);
    if (!before.ok) return before;
    const credential = await resolveCredential({ dependencies: input.dependencies, configuration: input.configuration }, optional);
    if (!credential.ok) return credential;
    const after = dispatchAllowed({ ...required, expiresAt: credential.value.expiresAt }, optional);
    if (!after.ok) return after;
    const result = await transport({ dependencies: input.dependencies, request: required.request, token: credential.value.accessToken, accountId: input.configuration.accountId }, optional);
    observe({ input, outcome: result.ok ? "received" : result.error.code });
    return result;
  } catch { return failure({ code: "unavailable" }); }
}

/** Current admission/cancellation/expiry fence on both sides of credential awaits; host rechecks at egress. O(1). */
function dispatchAllowed(required: { input: Checked; request: AppleRequest; expiresAt?: number }, optional?: CallOptions): Outcome<void> {
  if (required.input.dependencies.admitted !== true) return failure({ code: "forbidden" });
  if (optional?.signal?.aborted) return failure({ code: "cancelled" });
  const now = required.input.dependencies.clock.now({});
  if (!epochSchema.safeParse(now).success) return failure({ code: "invalid_input" });
  if (required.expiresAt !== undefined && now >= required.expiresAt) return failure({ code: "expired" });
  if (required.request.method === "POST" && now >= Date.parse(required.input.plan.campaign.startTime)) return failure({ code: "expired" });
  return { ok: true, value: undefined };
}

/** Reject stale schedules or clock faults before even the creative preflight. O(1), injected clock only. */
function futureStart(required: { input: Checked }): boolean {
  try { const now = required.input.dependencies.clock.now({}); return epochSchema.safeParse(now).success && Date.parse(required.input.plan.campaign.startTime) > now; }
  catch { return false; }
}

/** Correlated, sanitized metadata; host owns durable egress audit. O(1). */
function observe(required: { input: Checked; outcome: string }): void {
  const { context, dependencies } = required.input;
  try { dependencies.observer.observe({ operation: "apple-search-ads.deployment", outcome: required.outcome, correlationId: context.correlationId, traceId: context.traceId, runId: context.runId }); }
  catch { /* Telemetry cannot alter an acknowledged effect. */ }
}
function receipt(required: { references: References; hierarchy: unknown[]; status?: AppleSearchAdsDeploymentResult["status"] }): Outcome<AppleSearchAdsDeploymentResult> {
  return { ok: true, value: { ...required, status: required.status ?? "unknown", references: { ...required.references }, entityIds: Object.values(required.references) } };
}
