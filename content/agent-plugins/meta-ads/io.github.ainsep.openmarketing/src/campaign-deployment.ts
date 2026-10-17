import { z } from "zod";
import { isDeepStrictEqual } from "node:util";
import { callContextSchema, idSchema } from "@open-marketing/contracts";
import type { CallContext, CallOptions, Outcome } from "@open-marketing/contracts";
import { commandSchema, vendorIdSchema } from "./commands.js";
import { boundedJson, digest, failure, parse } from "./boundary.js";
import type { MetaInstagramDispatch } from "./instagram.js";

/** Closed traffic-only sequence; parent slots cannot name arbitrary substitution paths. */
export const campaignDeploymentPlanSchema = z.strictObject({
  campaign: commandSchema.options[0].extend({ objective: z.literal("OUTCOME_TRAFFIC"), specialAdCategories: z.array(z.never()).max(0) }),
  adset: commandSchema.options[1].extend({ campaignId: z.strictObject({ from: z.literal("campaign") }), schedule: commandSchema.options[1].shape.schedule.unwrap(), optimizationGoal: z.literal("LINK_CLICKS") }),
  ad: commandSchema.options[2].extend({ adsetId: z.strictObject({ from: z.literal("adset") }) }),
});
const referencesSchema = z.strictObject({ campaign: vendorIdSchema.optional(), adset: vendorIdSchema.optional(), ad: vendorIdSchema.optional() });
type References = z.infer<typeof referencesSchema>;
export interface MetaDeploymentResult { status: "acknowledged" | "unknown"; entityIds: string[]; references: References; hierarchy: unknown[] }
type Checkpoint = (input: { step: string; phase: "dispatch" | "acknowledged"; references: References }) => Promise<Outcome<void>>;
interface Input { context: CallContext; operationId: string; connectionId: string; accountId: string; plan: unknown; dependencies: { admitted: boolean; dispatch: MetaInstagramDispatch }; checkpoint: Checkpoint }
const inputSchema = z.strictObject({ context: callContextSchema, operationId: idSchema, connectionId: idSchema, accountId: vendorIdSchema, plan: campaignDeploymentPlanSchema });
type Checked = z.infer<typeof inputSchema> & Pick<Input, "dependencies">;
const rowSchema = z.object({ id: vendorIdSchema, account_id: vendorIdSchema, configured_status: z.literal("PAUSED"), name: z.string(),
  campaign_id: vendorIdSchema.optional(), adset_id: vendorIdSchema.optional(), objective: z.string().optional(), special_ad_categories: z.array(z.string()).optional(),
  targeting: z.object({ geo_locations: z.object({ countries: z.array(z.string()) }), age_min: z.number(), age_max: z.number() }).optional(),
  billing_event: z.string().optional(), optimization_goal: z.string().optional(), daily_budget: z.string().optional(),
  start_time: z.string().transform(Date.parse).optional(), end_time: z.string().transform(Date.parse).optional(), creative: z.object({ id: vendorIdSchema }).optional() });

/** Execute once within the host's approved job. The checkpoint rejects repeated dispatch intents.
 * @complexity Three sequential creates + three reads, each bounded by the injected Graph transport.
 * Errors stop creation; acknowledged IDs survive checkpoint/readback failure. No retries or rollback.
 */
export async function deployCampaignPaused(required: Input, optional?: CallOptions): Promise<Outcome<MetaDeploymentResult>> {
  const checked = checkInput({ input: required });
  if (!checked.ok) return checked;
  const input = { ...checked.value, checkpoint: required.checkpoint };
  const references: References = {};
  for (const step of ["campaign", "adset", "ad"] as const) {
    if (!await createStep({ input, step, references }, optional)) return receipt({ references });
  }
  return readCampaignDeployment({ ...input, references }, optional);
}

/** One fixed step: journal intent and acknowledged ID before its successor. O(1) bounded I/O. */
async function createStep(required: { input: Checked & Pick<Input, "checkpoint">; step: "campaign" | "adset" | "ad"; references: References }, optional?: CallOptions): Promise<boolean> {
  const { input, step, references } = required;
  if (optional?.signal?.aborted) return false;
  if (!await checkpoint({ input, step, phase: "dispatch", references })) return false;
  const body = creationBody({ input, step, references });
  const response = await graph({ input, method: "POST", path: `act_${input.accountId}/${step === "campaign" ? "campaigns" : step === "adset" ? "adsets" : "ads"}`, parameters: form({ body }) }, optional);
  if (!response.ok) return false;
  const ack = z.object({ id: vendorIdSchema }).safeParse(response.value);
  if (!ack.success || Object.values(references).includes(ack.data.id)) return false;
  references[step] = ack.data.id;
  if (!await checkpoint({ input, step, phase: "acknowledged", references })) return false;
  return true;
}

/** Reconcile saved IDs using GET only. Missing IDs/foreign parents/config drift remain unknown.
 * @complexity At most three bounded reads; no discovery, write, retry or continuation.
 */
export async function readCampaignDeployment(required: Omit<Input, "checkpoint"> & { references: unknown }, optional?: CallOptions): Promise<Outcome<MetaDeploymentResult>> {
  const checked = checkInput({ input: required });
  if (!checked.ok) return checked;
  const refs = parse({ schema: referencesSchema, input: required.references });
  if (!refs.ok) return refs;
  const input = checked.value;
  const references = refs.value;
  const hierarchy: unknown[] = [];
  for (const step of ["campaign", "adset", "ad"] as const) {
    const row = await readStep({ input, step, references }, optional);
    if (!row.ok) return receipt({ references, hierarchy });
    hierarchy.push(row.value);
  }
  return receipt({ references, hierarchy, status: "acknowledged" });
}

/** Verify one scoped row against its fixed creation payload; missing evidence denies. O(b). */
async function readStep(required: { input: Checked; step: "campaign" | "adset" | "ad"; references: References }, optional?: CallOptions): Promise<Outcome<unknown>> {
  const { input, step, references } = required;
  const id = references[step];
  if (!id || optional?.signal?.aborted) return failure({ code: "protocol_mismatch", message: "Meta deployment readback incomplete" });
  const expected = observedFields({ body: creationBody({ input, step, references }) });
  const response = await graph({ input, method: "GET", path: id, parameters: { fields: ["id", "account_id", "configured_status", ...Object.keys(expected)].join(",") } }, optional);
  if (!response.ok) return failure({ code: "protocol_mismatch", message: "Meta deployment readback incomplete" });
  const row = rowSchema.safeParse(response.value);
  if (!row.success || row.data.id !== id || row.data.account_id !== input.accountId) return failure({ code: "protocol_mismatch", message: "Meta deployment readback incomplete" });
  if (!Object.entries(expected).every(([key, value]) => isDeepStrictEqual(row.data[key as keyof typeof row.data], value))) return failure({ code: "protocol_mismatch", message: "Meta deployment readback incomplete" });
  return { ok: true, value: row.data };
}

/** Parse the complete snapshot before checkpoint/credentials; unadmitted calls do no I/O. O(b), <=64KiB. */
function checkInput(required: { input: Omit<Input, "checkpoint"> }): Outcome<Checked> {
  const input = required.input;
  if (input.dependencies.admitted !== true) return failure({ code: "forbidden", message: "Meta deployment unadmitted" });
  const bounded = boundedJson({ input: { context: input.context, operationId: input.operationId, connectionId: input.connectionId, accountId: input.accountId, plan: input.plan }, maxBytes: 65536 });
  if (!bounded.ok) return bounded;
  const parsed = parse({ schema: inputSchema, input: bounded.value });
  return parsed.ok ? { ok: true, value: { ...input, ...parsed.value } } : parsed;
}
/** Fixed actual Graph fields, never the proposed hosted MCP command payload. O(c), c<=25. */
function creationBody(required: { input: Checked; step: "campaign" | "adset" | "ad"; references: References }): Record<string, unknown> {
  const { input, step, references } = required;
  const marker = "om-" + digest({ value: input.operationId }).slice(0, 32);
  if (step === "campaign") return { name: marker, objective: "OUTCOME_TRAFFIC", special_ad_categories: [], status: "PAUSED" };
  if (step === "ad") return { name: marker + "-ad", adset_id: references.adset, creative: { creative_id: input.plan.ad.creativeId }, status: "PAUSED" };
  const command = input.plan.adset;
  return { name: marker + "-adset", campaign_id: references.campaign, status: "PAUSED", billing_event: command.billingEvent, optimization_goal: command.optimizationGoal,
    daily_budget: String(command.dailyBudgetMinor), start_time: new Date(command.schedule.start).toISOString(), end_time: new Date(command.schedule.end).toISOString(),
    targeting: { geo_locations: { countries: command.targeting.countries }, age_min: command.targeting.age_min, age_max: command.targeting.age_max } };
}
/** Redact thrown journal faults; an append failure always stops creation. O(1) I/O. */
async function checkpoint(required: { input: Checked & Pick<Input, "checkpoint">; step: string; phase: "dispatch" | "acknowledged"; references: References }): Promise<boolean> {
  try { return (await required.input.checkpoint({ step: required.step, phase: required.phase, references: { ...required.references } })).ok; }
  catch { return false; }
}
/** Normalize vendor read fields without accepting absent schedule or creative evidence. O(1). */
function observedFields(required: { body: Record<string, unknown> }): Record<string, unknown> {
  const { status: _status, ...expected } = required.body;
  if (expected.start_time) expected.start_time = Date.parse(String(expected.start_time));
  if (expected.end_time) expected.end_time = Date.parse(String(expected.end_time));
  if (expected.creative) expected.creative = { id: (expected.creative as { creative_id: string }).creative_id };
  return expected;
}
function form(required: { body: Record<string, unknown> }): Record<string, string> { return Object.fromEntries(Object.entries(required.body).map(([key, value]) => [key, typeof value === "string" ? value : JSON.stringify(value)])); }
/** Host dispatch owns per-fetch final authority and audit. Exceptions never erase saved IDs. O(b). */
async function graph(required: { input: Checked; method: "GET" | "POST"; path: string; parameters: Record<string, string> }, optional?: CallOptions): Promise<Outcome<unknown>> {
  const { input } = required;
  if (input.dependencies.admitted !== true) return failure({ code: "forbidden", message: "Meta deployment unadmitted" });
  if (optional?.signal?.aborted) return failure({ code: "cancelled", message: "Meta deployment cancelled" });
  try { return await input.dependencies.dispatch({ context: input.context, operationId: input.operationId, connectionId: input.connectionId, timeoutMs: 15000,
    effect: { operationId: input.operationId, connectionId: input.connectionId, accountId: input.accountId, effects: [required.method === "GET" ? "read" : "write"], argumentsDigest: digest({ value: { plan: input.plan, operationId: input.operationId, apiVersion: "v25.0" } }), moneyExposure: null, requiredLimit: null },
    request: { method: required.method, endpoint: "https://graph.facebook.com/v25.0/" + required.path, parameters: required.parameters } }, optional); }
  catch { return failure({ code: "unavailable", message: "Meta deployment outcome unknown" }); }
}
function receipt(required: { references: References; hierarchy?: unknown[]; status?: MetaDeploymentResult["status"] }): Outcome<MetaDeploymentResult> { return { ok: true, value: { status: required.status ?? "unknown", references: { ...required.references }, entityIds: Object.values(required.references), hierarchy: required.hierarchy ?? [] } }; }
