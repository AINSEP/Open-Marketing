/** Four finite writes inside the host's existing grouped approval/outbox; no activation or retry. */
import { z } from "zod";
import { isDeepStrictEqual } from "node:util";
import { callContextSchema, idSchema } from "@open-marketing/contracts";
import type { CallContext, CallOptions, Outcome } from "@open-marketing/contracts";
import { vendorId } from "./commands.js";
import { boundedJson, configurationSchema, failure, requestXAds, resolveCredential } from "./transport.js";
import type { WireRequest, XConfiguration, XDependencies } from "./transport.js";

const micros = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const name = z.string().min(1).max(255);
const timestamp = z.iso.datetime().refine(value => Date.parse(value) >= 0 && Date.parse(value) % 1000 === 0);
/** Closed fixed-slot plan; no endpoint overrides, arbitrary writes or status defaults.
 * @example campaignDeploymentPlanSchema.safeParse(translatedPlan)
 */
export const campaignDeploymentPlanSchema = z.strictObject({
  accountId: vendorId, currency: z.string().regex(/^[A-Z]{3}$/),
  campaign: z.strictObject({ name, funding_instrument_id: vendorId, entity_status: z.literal("PAUSED"), budget_optimization: z.literal("LINE_ITEM"), daily_budget_amount_local_micro: micros }),
  lineItem: z.strictObject({ name, campaign_id: z.strictObject({ from: z.literal("campaign") }), entity_status: z.literal("PAUSED"), objective: z.literal("WEBSITE_CLICKS"), product_type: z.literal("PROMOTED_TWEETS"), placements: z.literal("ALL_ON_TWITTER"), bid_strategy: z.literal("MAX"), goal: z.literal("LINK_CLICKS"), bid_amount_local_micro: micros, daily_budget_amount_local_micro: micros, standard_delivery: z.literal(true), start_time: timestamp, end_time: timestamp }),
  targeting: z.strictObject({ line_item_id: z.strictObject({ from: z.literal("lineItem") }), targeting_type: z.literal("LOCATION"), operator_type: z.literal("EQ"), targeting_value: vendorId }),
  promotedTweet: z.strictObject({ line_item_id: z.strictObject({ from: z.literal("lineItem") }), tweet_ids: z.string().regex(/^[1-9][0-9]{0,19}$/) }),
}).refine(plan => Date.parse(plan.lineItem.start_time) < Date.parse(plan.lineItem.end_time) && plan.campaign.daily_budget_amount_local_micro === plan.lineItem.daily_budget_amount_local_micro);
/** Frozen vendor plan produced before the grouped approval card. */
export type XPausedPlan = z.infer<typeof campaignDeploymentPlanSchema>;
const referencesSchema = z.strictObject({ campaign: vendorId.optional(), lineItem: vendorId.optional(), targeting: vendorId.optional(), promotedTweet: vendorId.optional() });
/** Includes targeting candidates, even if later readback/checkpoint fails. */
export type XDeploymentReferences = z.infer<typeof referencesSchema>;
/** Acknowledged means the entire hierarchy was read back; it never means serving/activated. */
export interface XDeploymentResult { status: "acknowledged" | "unknown"; references: XDeploymentReferences; entityIds: string[]; hierarchy: unknown[] }
type Step = keyof XDeploymentReferences;
const steps = ["campaign", "lineItem", "targeting", "promotedTweet"] as const;
const resources = { campaign: "campaigns", lineItem: "line_items", targeting: "targeting_criteria", promotedTweet: "promoted_tweets" };
/** Host fetch MUST recheck frozen plan/digest, current binding/admission, halt and owning grouped
 * exact authority after each credential lookup. No nested gateway claim or second outbox.
 */
export type XDeploymentDependencies = Omit<XDependencies, "gateway" | "configuration"> & { configuration: XConfiguration };
type Checkpoint = (input: { step: string; phase: "dispatch" | "acknowledged"; references: XDeploymentReferences }) => Promise<Outcome<void>>;
interface Input { context: CallContext; operationId: string; plan: unknown; dependencies: XDeploymentDependencies }
const inputSchema = z.strictObject({ context: callContextSchema, operationId: idSchema, plan: campaignDeploymentPlanSchema, configuration: configurationSchema });
type Checked = z.infer<typeof inputSchema> & Pick<Input, "dependencies">;
const envelope = z.object({ request: z.object({ params: z.object({ account_id: vendorId }) }), data: z.unknown() });
const rowSchema = z.object({ id: vendorId, deleted: z.literal(false) }).catchall(z.unknown());

/** Checkpoint dispatch/ID then GET each entity before creating its successor. Any uncertainty
 * stops with known references; the host checkpoint must reject already-dispatched intents.
 * @example deployCampaignPaused({ context, operationId, plan, dependencies, checkpoint })
 * @complexity Four creates + eight scoped GETs at most, each <=15s/1MiB; O(b) storage, no retries.
 */
export async function deployCampaignPaused(required: Input & { checkpoint: Checkpoint }, optional: CallOptions = {}): Promise<Outcome<XDeploymentResult>> {
  const checked = checkInput({ input: required }, optional);
  if (!checked.ok) return checked;
  const input = { ...checked.value, checkpoint: required.checkpoint };
  const references: XDeploymentReferences = {};
  for (const step of steps) {
    if (!await createStep({ input, step, references }, optional)) return receipt({ references });
  }
  const observed = await readCampaignDeployment({ ...input, references }, optional);
  return observed.ok ? observed : receipt({ references });
}

/** GET-only reconciliation of saved IDs; missing IDs are never discovered by resending a create.
 * @example readCampaignDeployment({ context, operationId, plan, references, dependencies })
 * @complexity <=4 scoped GETs, O(b) storage, each <=15s/1MiB; stops on first mismatch/failure.
 */
export async function readCampaignDeployment(required: Input & { references: unknown }, optional: CallOptions = {}): Promise<Outcome<XDeploymentResult>> {
  const checked = checkInput({ input: required }, optional);
  if (!checked.ok) return checked;
  const bounded = boundedJson({ input: required.references });
  if (!bounded.ok) return bounded;
  const parsed = referencesSchema.safeParse(bounded.value);
  if (!parsed.success) return failure({ code: "invalid_input" });
  const references = parsed.data;
  const hierarchy: unknown[] = [];
  for (const step of steps) {
    const row = await readStep({ input: checked.value, step, references }, optional);
    if (!row.ok) return receipt({ references, hierarchy });
    hierarchy.push(row.value);
  }
  return receipt({ references, hierarchy, status: "acknowledged" });
}

/** Candidate IDs survive journal or readback failure. No next write until readback passes. O(b). */
async function createStep(required: { input: Checked & { checkpoint: Checkpoint }; step: Step; references: XDeploymentReferences }, optional: CallOptions): Promise<boolean> {
  const { input, step, references } = required;
  if (!await checkpoint({ ...required, phase: "dispatch" })) return false;
  const params = parameters(required);
  const query = new URLSearchParams(Object.entries(params).map(([key, value]) => [key, String(value)]));
  const response = await send({ input, request: { url: base(required) + "?" + query, method: "POST" } }, optional);
  if (!response.ok) return false;
  const ack = z.object({ data: z.unknown() }).safeParse(response.value.body);
  if (!ack.success) return false;
  const data = step === "promotedTweet" ? z.array(z.object({ id: vendorId })).length(1).safeParse(ack.data.data) : z.object({ id: vendorId }).safeParse(ack.data.data);
  if (!data.success) return false;
  references[step] = Array.isArray(data.data) ? data.data[0].id : data.data.id;
  if (!await checkpoint({ ...required, phase: "acknowledged" })) return false;
  return (await readStep(required, optional)).ok;
}

/** Schema projection checks parents, currency, funding, budgets, fixed traffic fields and schedule.
 * The promoted Tweet's own status is read-only; serving is prevented by both PAUSED parents.
 * O(b) time/space; no provider row fields escape except reviewed fields and candidate ID.
 */
async function readStep(required: { input: Checked; step: Step; references: XDeploymentReferences }, optional: CallOptions): Promise<Outcome<unknown>> {
  const { input, step, references } = required;
  const id = references[step];
  if (!id) return failure({ code: "protocol_mismatch" });
  const response = await send({ input, request: { url: base(required) + "/" + id, method: "GET" } }, optional);
  if (!response.ok) return response;
  const parsed = envelope.safeParse(response.value.body);
  if (!parsed.success || parsed.data.request.params.account_id !== input.configuration.accountId) return failure({ code: "protocol_mismatch" });
  const expected = expectedRow(required);
  const row = rowSchema.safeParse(parsed.data.data);
  if (!row.success || row.data.id !== id || !rowMatches({ row: row.data, expected })) return failure({ code: "protocol_mismatch" });
  return { ok: true, value: { id, ...expected } };
}

/** Tainted readback comparisons preserve exact integers and normalize only ISO times/placements. O(k), fixed keys. */
function rowMatches(required: { row: Record<string, unknown>; expected: Record<string, unknown> }): boolean {
  if (required.expected.entity_status === "PAUSED" && required.row.servable === true) return false;
  if (required.expected.targeting_type === "LOCATION" && required.row.operator_type !== undefined && required.row.operator_type !== "EQ") return false;
  return Object.entries(required.expected).every(([key, value]) => valueMatches({ key, value, observed: required.row[key] }));
}
/** Normalize documented timestamp/placement representations only; money remains exact. O(1). */
function valueMatches(required: { key: string; value: unknown; observed: unknown }): boolean {
  const { key, value, observed } = required;
  if (key === "start_time" || key === "end_time") return typeof observed === "string" && Date.parse(observed) === Date.parse(String(value));
  if (key === "placements") return isDeepStrictEqual(observed, [value]);
  return isDeepStrictEqual(observed, value);
}

/** Only fixed acknowledged parent slots are substituted; all other bytes come from the parsed plan. O(1). */
function parameters(required: { input: Checked; step: Step; references: XDeploymentReferences }): Record<string, string | number | boolean> {
  const { input, step, references } = required;
  switch (step) {
    case "campaign": return { ...input.plan.campaign };
    case "lineItem": return { ...input.plan.lineItem, campaign_id: references.campaign! };
    case "targeting": return { ...input.plan.targeting, line_item_id: references.lineItem! };
    case "promotedTweet": return { ...input.plan.promotedTweet, line_item_id: references.lineItem! };
    default: { const exhaustive: never = step; return exhaustive; }
  }
}
/** Match the documented response shape, including attachment tweet_id rather than tweet_ids. O(1). */
function expectedRow(required: Parameters<typeof parameters>[0]): Record<string, unknown> {
  const params = parameters(required);
  if (required.step === "promotedTweet") return { line_item_id: params.line_item_id, tweet_id: params.tweet_ids };
  // The documented targeting response omits operator_type; explicit conflicts reject separately.
  if (required.step === "targeting") { const { operator_type: _operator, ...targeting } = params; return targeting; }
  return { ...params, currency: required.input.plan.currency };
}
function base(required: { input: Checked; step: Step }): string { return `https://ads-api.x.com/12/accounts/${required.input.configuration.accountId}/${resources[required.step]}`; }

/** Complete admission/scope/plan snapshot before credentials or checkpoint I/O. O(b), b<=64KiB. */
function checkInput(required: { input: Input }, optional: CallOptions): Outcome<Checked> {
  const { input } = required;
  if (!input.dependencies.configuration.admitted) return failure({ code: "forbidden" });
  if (optional.signal?.aborted) return failure({ code: "cancelled" });
  const bounded = boundedJson({ input: { context: input.context, operationId: input.operationId, plan: input.plan, configuration: input.dependencies.configuration } });
  if (!bounded.ok) return bounded;
  const parsed = inputSchema.safeParse(bounded.value);
  if (!parsed.success) return failure({ code: "invalid_input" });
  const { context, configuration, plan } = parsed.data;
  if (!isDeepStrictEqual(context.scope, configuration.scope) || plan.accountId !== configuration.accountId || plan.currency !== configuration.currency) return failure({ code: "forbidden" });
  return { ok: true, value: { ...parsed.data, dependencies: input.dependencies } };
}

/** A failed durable append forbids continuation; copied refs cannot mutate the in-flight state. O(1). */
async function checkpoint(required: { input: Checked & { checkpoint: Checkpoint }; step: Step; phase: "dispatch" | "acknowledged"; references: XDeploymentReferences }): Promise<boolean> {
  try { return (await required.input.checkpoint({ step: required.step, phase: required.phase, references: { ...required.references } })).ok; }
  catch { return false; }
}

/** Credential lookup precedes the host's guarded fetch; each call checks live admission again.
 * O(b) plus signing; one lookup + one bounded HTTP, no tokens retained in results/observations.
 */
async function send(required: { input: Checked; request: WireRequest }, optional: CallOptions): ReturnType<typeof requestXAds> {
  const { input, request } = required;
  try {
    if (!input.dependencies.configuration.admitted || optional.signal?.aborted) return failure({ code: "forbidden" });
    const credential = await resolveCredential({ dependencies: input.dependencies, configuration: input.configuration }, optional);
    if (!credential.ok) return credential;
    const result = await requestXAds({ dependencies: input.dependencies, request, credential: credential.value, isCurrent: () => input.dependencies.configuration.admitted }, optional);
    observe({ input, outcome: result.ok ? "received" : result.error.code });
    return result;
  } catch { return failure({ code: "unavailable" }); }
}
/** Secret-free correlated I/O outcome; host owns durable audit. O(1). */
function observe(required: { input: Checked; outcome: string }): void {
  const { context, dependencies } = required.input;
  try { dependencies.observer.observe({ operation: "x_ads.deployment", outcome: required.outcome, correlationId: context.correlationId, traceId: context.traceId, runId: context.runId }); }
  catch { /* Telemetry cannot erase acknowledged IDs. */ }
}
function receipt(required: { references: XDeploymentReferences; hierarchy?: unknown[]; status?: XDeploymentResult["status"] }): Outcome<XDeploymentResult> { return { ok: true, value: { status: required.status ?? "unknown", references: { ...required.references }, entityIds: Object.values(required.references), hierarchy: required.hierarchy ?? [] } }; }
