import { z } from "zod";
import { isDeepStrictEqual } from "node:util";
import { callContextSchema, pluginConfigurationSchema, idSchema } from "@open-marketing/contracts";
import type { CampaignDeploymentRequired, CampaignDeploymentReceipt, CallOptions, Outcome } from "@open-marketing/contracts";
import { commandSchema, vendorIdSchema } from "./commands.js";
import { boundedJson, digest, failure, parse } from "./boundary.js";
import type { MetaInstagramDispatch } from "./instagram.js";
import { adsGraphVersion, createConfiguredDispatch } from "./instagram-fetch.js";

const targetingSchema = z.strictObject({
  countries: commandSchema.options[1].shape.targeting.shape.countries.optional(),
  zips: z.array(z.strictObject({ key: z.string().min(1).max(64) })).min(1).max(200).optional(),
  custom_locations: z.array(z.strictObject({ latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180),
    radius: z.number().min(1).max(80), distance_unit: z.literal("kilometer") })).length(1).optional(),
  age_min: commandSchema.options[1].shape.targeting.shape.age_min,
  age_max: commandSchema.options[1].shape.targeting.shape.age_max,
}).refine(value => [value.countries, value.zips, value.custom_locations].filter(item => item !== undefined).length === 1 && value.age_min <= value.age_max);

/** Closed traffic-only plan with one geography and an explicit destination.
 * Parent slots cannot name arbitrary substitution paths; parsing enforces geography exclusivity.
 */
export const campaignDeploymentPlanSchema = z.strictObject({
  campaign: commandSchema.options[0].extend({ objective: z.literal("OUTCOME_TRAFFIC"), specialAdCategories: z.array(z.never()).max(0) }),
  adset: commandSchema.options[1].extend({ campaignId: z.strictObject({ from: z.literal("campaign") }), targeting: targetingSchema, schedule: commandSchema.options[1].shape.schedule.unwrap(), optimizationGoal: z.literal("LINK_CLICKS") }),
  ad: commandSchema.options[2].extend({ adsetId: z.strictObject({ from: z.literal("adset") }), destinationUrl: z.url({ protocol: /^https?$/ }).max(2048) }),
});
const referencesSchema = z.strictObject({ campaign: vendorIdSchema.optional(), adset: vendorIdSchema.optional(), ad: vendorIdSchema.optional() });
type References = z.infer<typeof referencesSchema>;
export type MetaDeploymentResult = CampaignDeploymentReceipt & { references: References; hierarchy: unknown[] };
const inputSchema = z.strictObject({ context: callContextSchema, operationId: idSchema, connectionId: idSchema, accountId: vendorIdSchema, plan: campaignDeploymentPlanSchema });
type Checked = z.infer<typeof inputSchema> & { dependencies: { dispatch: MetaInstagramDispatch } };
const rowSchema = z.object({ id: vendorIdSchema, account_id: vendorIdSchema, configured_status: z.literal("PAUSED"), name: z.string(),
  campaign_id: vendorIdSchema.optional(), adset_id: vendorIdSchema.optional(), objective: z.string().optional(), special_ad_categories: z.array(z.string()).optional(),
  targeting: z.object({ geo_locations: z.strictObject({ countries: z.array(z.string()).optional(),
    zips: z.array(z.object({ key: z.string() })).transform(values => values.sort((a, b) => a.key.localeCompare(b.key))).optional(),
    custom_locations: z.array(z.object({ latitude: z.number(), longitude: z.number(), radius: z.number(), distance_unit: z.string() })).optional(),
    location_types: z.array(z.string()).optional(),
  }).transform(({ location_types: _locationTypes, ...geo }) => geo), age_min: z.number(), age_max: z.number() }).optional(),
  billing_event: z.string().optional(), optimization_goal: z.string().optional(), daily_budget: z.string().optional(),
  start_time: z.string().transform(Date.parse).optional(), end_time: z.string().transform(Date.parse).optional(), creative: z.object({ id: vendorIdSchema }).optional() });

/** Execute once within the host's approved job. The checkpoint rejects repeated dispatch intents.
 * A scoped single-link creative must match the planned destination before any checkpoint or POST.
 * @example await deployCampaignPaused({ ...job, plan: translatedPlan })
 * @complexity Three sequential creates + four reads, each bounded by the injected Graph transport.
 * Errors stop creation; acknowledged IDs survive checkpoint/readback failure. No retries or rollback.
 */
export async function deployCampaignPaused(required: CampaignDeploymentRequired, optional?: CallOptions): Promise<Outcome<MetaDeploymentResult>> {
  const checked = checkInput({ input: required });
  if (!checked.ok) return checked;
  const saved = required.saved;
  const refs = parse({ schema: referencesSchema, input: saved.references });
  if (!refs.ok) return refs;
  if (Object.keys(refs.value).length > 0 || saved.record !== null) return readCampaignDeployment(required, optional);
  const destination = await verifyDestination({ input: checked.value }, optional);
  if (!destination.ok) return destination;
  const input = { ...checked.value, checkpoint: required.checkpoint };
  const references: References = {};
  for (const step of ["campaign", "adset", "ad"] as const) {
    if (!await createStep({ input, step, references }, optional)) return receipt({ references });
  }
  return readCampaignDeployment({ ...required, saved: { references, record: null } }, optional);
}

/** Prove ownership and the immutable single-link destination; unsupported creative forms conflict.
 * @complexity One bounded GET, O(b) parsing time/space; never checkpoints or writes.
 */
async function verifyDestination(required: { input: Checked }, optional?: CallOptions): Promise<Outcome<void>> {
  const { input } = required;
  const response = await graph({ input, method: "GET", path: input.plan.ad.creativeId, parameters: { fields: "account_id,object_story_spec,asset_feed_spec" } }, optional);
  if (!response.ok) return response;
  const creative = z.object({ account_id: vendorIdSchema, asset_feed_spec: z.undefined().optional(),
    object_story_spec: z.object({ link_data: z.object({ link: z.string(), child_attachments: z.undefined().optional() }) }),
  }).safeParse(response.value);
  if (!creative.success || creative.data.account_id !== input.accountId || creative.data.object_story_spec.link_data.link !== input.plan.ad.destinationUrl) return failure({ code: "conflict", message: "Meta creative cannot verify the requested destination" });
  return { ok: true, value: undefined };
}

/** One fixed step: journal intent and acknowledged ID before its successor. O(1) bounded I/O. */
async function createStep(required: { input: Checked & Pick<CampaignDeploymentRequired, "checkpoint">; step: "campaign" | "adset" | "ad"; references: References }, optional?: CallOptions): Promise<boolean> {
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
export async function readCampaignDeployment(required: CampaignDeploymentRequired, optional?: CallOptions): Promise<Outcome<MetaDeploymentResult>> {
  const checked = checkInput({ input: required });
  if (!checked.ok) return checked;
  const refs = parse({ schema: referencesSchema, input: required.saved.references });
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

/** Parse the complete snapshot before checkpoint/credentials; the server dispatch owns authority. O(b), <=64KiB. */
function checkInput(required: { input: CampaignDeploymentRequired }): Outcome<Checked> {
  const input = required.input;
  const bounded = boundedJson({ input: { context: input.context, operationId: input.operationId, connectionId: input.connectionId, accountId: input.accountId, plan: input.plan }, maxBytes: 65536 });
  if (!bounded.ok) return bounded;
  const parsed = parse({ schema: inputSchema, input: bounded.value });
  if (!parsed.ok) return parsed;
  const configuration = pluginConfigurationSchema.safeParse(input.dependencies.configuration);
  if (!configuration.success) return failure({ code: "invalid_input", message: "Invalid deployment configuration" });
  const binding = configuration.data;
  if (!isDeepStrictEqual({ connectionId: binding.connectionId, accountId: binding.accountId, scope: binding.scope }, { connectionId: input.connectionId, accountId: input.accountId, scope: parsed.value.context.scope })) return failure({ code: "forbidden", message: "Deployment binding mismatch" });
  const configured = createConfiguredDispatch(input.dependencies);
  if (!configured.ok) return configured;
  return { ok: true, value: { ...parsed.value, dependencies: { dispatch: configured.value.dispatch } } };
}
/** Fixed actual Graph fields, never the proposed hosted MCP command payload. O(p), p<=200 locations. */
function creationBody(required: { input: Checked; step: "campaign" | "adset" | "ad"; references: References }): Record<string, unknown> {
  const { input, step, references } = required;
  const marker = "om-" + digest({ value: input.operationId }).slice(0, 32);
  if (step === "campaign") return { name: marker, objective: "OUTCOME_TRAFFIC", special_ad_categories: [], status: "PAUSED" };
  if (step === "ad") return { name: marker + "-ad", adset_id: references.adset, creative: { creative_id: input.plan.ad.creativeId }, status: "PAUSED" };
  const command = input.plan.adset;
  const { age_min, age_max, ...geo_locations } = command.targeting;
  return { name: marker + "-adset", campaign_id: references.campaign, status: "PAUSED", billing_event: command.billingEvent, optimization_goal: command.optimizationGoal,
    daily_budget: String(command.dailyBudgetMinor), start_time: new Date(command.schedule.start).toISOString(), end_time: new Date(command.schedule.end).toISOString(),
    targeting: { geo_locations, age_min, age_max } };
}
/** Redact thrown journal faults; an append failure always stops creation. O(1) I/O. */
async function checkpoint(required: { input: Checked & Pick<CampaignDeploymentRequired, "checkpoint">; step: string; phase: "dispatch" | "acknowledged"; references: References }): Promise<boolean> {
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
  if (optional?.signal?.aborted) return failure({ code: "cancelled", message: "Meta deployment cancelled" });
  try { return await input.dependencies.dispatch({ context: input.context, operationId: input.operationId, connectionId: input.connectionId, timeoutMs: 15000,
    effect: { operationId: input.operationId, connectionId: input.connectionId, accountId: input.accountId, effects: [required.method === "GET" ? "read" : "write"], argumentsDigest: digest({ value: { plan: input.plan, operationId: input.operationId, apiVersion: adsGraphVersion } }), moneyExposure: null, requiredLimit: null },
    request: { method: required.method, endpoint: `https://graph.facebook.com/${adsGraphVersion}/` + required.path, parameters: required.parameters } }, optional); }
  catch { return failure({ code: "unavailable", message: "Meta deployment outcome unknown" }); }
}
/** Build paused-state evidence while retaining all known IDs on uncertainty. O(1), three IDs maximum. */
function receipt(required: { references: References; hierarchy?: unknown[]; status?: MetaDeploymentResult["status"] }): Outcome<MetaDeploymentResult> { return { ok: true, value: { state: "paused", status: required.status ?? "unknown", references: { ...required.references }, entityIds: Object.values(required.references), hierarchy: required.hierarchy ?? [] } }; }
