import { z } from "zod";
import { isDeepStrictEqual } from "node:util";
import { callContextSchema, idSchema } from "@open-marketing/contracts";
import type { CallContext, CallOptions, Outcome } from "@open-marketing/contracts";
import { campaignDeploymentPlanSchema, deploymentId, exactInteger, imageCreativeSchema, pausedAdSchema, pausedAdgroupSchema, pausedCampaignSchema, verifiedDeploymentCountries } from "./commands.js";
import { boundedInput, configurationSchema, failure, requestLineAds } from "./transport.js";
import type { LineAdsDependencies } from "./ports.js";
export { campaignDeploymentPlanSchema } from "./commands.js";

const steps = ["campaign", "adgroup", "ad"] as const;
type Step = typeof steps[number];
const providerId = z.union([deploymentId, exactInteger.transform(String)]);
const referencesSchema = z.strictObject({ campaign: deploymentId.optional(), adgroup: deploymentId.optional(), ad: deploymentId.optional() });
type References = z.infer<typeof referencesSchema>;
/** Known references survive all uncertain outcomes; hierarchy contains only verified observations. */
export interface LineAdsDeploymentResult { status: "acknowledged" | "unknown"; entityIds: string[]; references: References; hierarchy: unknown[] }
type Checkpoint = (input: { step: string; phase: "dispatch" | "acknowledged"; references: References }) => Promise<Outcome<void>>;
interface Input { context: CallContext; operationId: string; plan: unknown; dependencies: LineAdsDependencies; checkpoint: Checkpoint }
const inputSchema = z.strictObject({ context: callContextSchema, operationId: idSchema, plan: campaignDeploymentPlanSchema, configuration: configurationSchema });
type Checked = z.infer<typeof inputSchema> & Pick<Input, "dependencies">;
const nonServing = z.enum(["PAUSED", "NOT_DELIVERING", "NOT_APPROVED"]);
/** Project consumed response fields; LINE enriches Creative and CallToAction. POST schemas stay strict. */
const creativeResponse = z.object({ ...imageCreativeSchema.shape, callToAction: z.object(imageCreativeSchema.shape.callToAction.shape) });
const rows = { campaign: z.object({ ...pausedCampaignSchema.shape, id: providerId, deliveryStatus: nonServing }),
  adgroup: z.object({ ...pausedAdgroupSchema.shape, id: providerId, deliveryStatus: nonServing }),
  ad: z.object({ ...pausedAdSchema.shape, creative: creativeResponse, id: providerId, adaccountId: deploymentId, deliveryStatus: nonServing }) };

/** Fixed PAUSED sequence under the SAME approved host job/card; no second policy or outbox.
 * @param required - Frozen plan, guarded dependencies and durable host checkpoints rejecting repeated dispatch.
 * @returns Typed preflight failure, or receipt retaining every known ID on uncertainty.
 * @example deployCampaignPaused({ context, operationId, plan, dependencies, checkpoint })
 * @complexity One account GET + three POST/filtered-GET pairs, <=15s/1MiB each; no retry/rollback/resume.
 */
export async function deployCampaignPaused(required: Input, optional?: CallOptions): Promise<Outcome<LineAdsDeploymentResult>> {
  const checked = checkInput({ input: required });
  if (!checked.ok) return checked;
  const input = { ...checked.value, checkpoint: required.checkpoint };
  const references: References = {}, hierarchy: unknown[] = [];
  if (!await accountMatches({ input }, optional)) return receipt({ references, hierarchy });
  for (const step of steps) {
    if (!await createStep({ input, step, references }, optional)) return receipt({ references, hierarchy });
    const row = await readStep({ input, step, references }, optional);
    if (!row.ok) return receipt({ references, hierarchy });
    hierarchy.push(row.value);
  }
  return receipt({ references, hierarchy, status: "acknowledged" });
}
/** Append dispatch before POST, then candidate ID before GET/child. Checkpoint faults always stop.
 * @complexity One bounded create; candidate references mutate only this invocation's local journal view.
 */
async function createStep(required: { input: Checked & Pick<Input, "checkpoint">; step: Step; references: References }, optional?: CallOptions): Promise<boolean> {
  const { input, step, references } = required;
  if (optional?.signal?.aborted || !await checkpoint({ ...required, phase: "dispatch" })) return false;
  const request = { url: collection({ input, step }), method: "POST" as const, body: JSON.stringify(payload(required)) };
  const response = await send({ input, request }, optional);
  if (!response.ok) return false;
  const ack = z.object({ id: providerId }).safeParse(response.value);
  if (!ack.success) return false;
  references[step] = ack.data.id;
  return checkpoint({ ...required, phase: "acknowledged" });
}
/** Saved-reference reconciliation uses account discovery and collection GETs with ids only.
 * @param required - Original frozen plan and saved references under current authority.
 * @returns Unknown on any missing/conflicting observation; never resumes or resends a create.
 * @example readCampaignDeployment({ context, operationId, plan, dependencies, references })
 * @complexity At most four bounded GETs; no scan beyond the first 100-account page, no writes.
 */
export async function readCampaignDeployment(required: Omit<Input, "checkpoint"> & { references: unknown }, optional?: CallOptions): Promise<Outcome<LineAdsDeploymentResult>> {
  const checked = checkInput({ input: required });
  if (!checked.ok) return checked;
  const parsed = referencesSchema.safeParse(required.references);
  if (!parsed.success) return failure({ code: "invalid_input" });
  const references = parsed.data, hierarchy: unknown[] = [];
  const input = checked.value;
  if (!references.campaign || !await accountMatches({ input }, optional)) return receipt({ references, hierarchy });
  for (const step of steps) {
    const row = await readStep({ input, step, references }, optional);
    if (!row.ok) return receipt({ references, hierarchy });
    hierarchy.push(row.value);
  }
  return receipt({ references, hierarchy, status: "acknowledged" });
}
/** Exact consumed ID/parent/payload/non-serving comparison after response projection; missing fields/extra rows stay unknown. O(b). */
async function readStep(required: { input: Checked; step: Step; references: References }, optional?: CallOptions): Promise<Outcome<unknown>> {
  const { input, step, references } = required;
  const id = references[step];
  if (!id) return failure({ code: "protocol_mismatch" });
  const response = await send({ input, request: { url: collection({ input, step }) + "?ids=" + id + "&page=1&size=1", method: "GET" } }, optional);
  if (!response.ok) return response;
  const page = z.object({ datas: z.array(rows[step]).length(1), paging: z.object({ page: z.literal(1), size: z.literal(1), totalElements: z.literal(1) }) }).safeParse(response.value);
  if (!page.success) return failure({ code: "protocol_mismatch" });
  const { id: observedId, deliveryStatus, ...observed } = page.data.datas[0];
  const expected = step === "ad" ? { ...payload(required), adaccountId: input.configuration.accountId } : payload(required);
  if (observedId !== id || !isDeepStrictEqual(observed, expected)) return failure({ code: "protocol_mismatch" });
  return { ok: true, value: { id, deliveryStatus, ...observed } };
}
/** Confirm currency/timezone/country on a bounded authenticated-group account page before any POST.
 * No undocumented account-by-ID endpoint or filter is invented. O(n), n<=100; missing ID denies.
 */
async function accountMatches(required: { input: Checked }, optional?: CallOptions): Promise<boolean> {
  const response = await send({ input: required.input, request: { kind: "list_accounts", page: 1, size: 100 } }, optional);
  if (!response.ok) return false;
  const page = z.object({ datas: z.array(z.object({ id: providerId, currency: z.string(), timezone: z.string(), country: z.string() })).max(100),
    paging: z.object({ page: z.literal(1), size: z.literal(100), totalElements: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) }) }).safeParse(response.value);
  if (!page.success || page.data.datas.length !== Math.min(100, page.data.paging.totalElements)) return false;
  const account = page.data.datas.filter(row => row.id === required.input.configuration.accountId);
  const { accountId, currency, timezone, country } = required.input.configuration;
  return account.length === 1 && isDeepStrictEqual(account[0], { id: accountId, currency, timezone, country });
}
/** Bounded snapshot, exact scope/metadata and hard regional evidence gate precede all effects. O(b). */
function checkInput(required: { input: Omit<Input, "checkpoint"> }): Outcome<Checked> {
  const input = required.input;
  if (input.dependencies.admitted !== true) return failure({ code: "forbidden" });
  const bounded = boundedInput({ input: { context: input.context, operationId: input.operationId, plan: input.plan, configuration: input.dependencies.configuration } });
  if (!bounded.ok) return bounded;
  const parsed = inputSchema.safeParse(bounded.value);
  if (!parsed.success) return failure({ code: "invalid_input" });
  const { context, configuration, plan } = parsed.data;
  if (!isDeepStrictEqual(context.scope, configuration.scope)) return failure({ code: "forbidden" });
  if (!verifiedDeploymentCountries.includes(configuration.country) || configuration.country === "JP") return failure({ code: "unavailable" });
  if (!["accountId", "country", "currency", "timezone"].every(key => Reflect.get(configuration, key) === Reflect.get(plan.metadata, key))) return failure({ code: "conflict" });
  return { ok: true, value: { ...parsed.data, dependencies: input.dependencies } };
}
function collection(required: { input: Checked; step: Step }): string { return "https://ads.line.me/api/v3/adaccounts/" + required.input.configuration.accountId + "/" + required.step + "s"; }
/** Only two approved parent substitutions. Missing parents cannot produce a validated readback. */
function payload(required: { input: Checked; step: Step; references: References }): Record<string, unknown> {
  const { input, step, references } = required;
  if (step === "adgroup") return { ...input.plan.adgroup, campaignId: Number(references.campaign) };
  if (step === "ad") return { ...input.plan.ad, adgroupId: Number(references.adgroup) };
  return input.plan.campaign;
}
/** Opaque durable-append faults stop; callback receives its own reference snapshot. O(1). */
async function checkpoint(required: { input: Checked & Pick<Input, "checkpoint">; step: Step; phase: "dispatch" | "acknowledged"; references: References }): Promise<boolean> {
  try { return (await required.input.checkpoint({ step: required.step, phase: required.phase, references: { ...required.references } })).ok; }
  catch { return false; }
}
/** Shared transport performs fresh custody and live fences; observer receives correlation only. O(b). */
async function send(required: { input: Checked; request: Parameters<typeof requestLineAds>[0]["request"] }, optional?: CallOptions): Promise<Outcome<unknown>> {
  const { dependencies: host } = required.input;
  // Writes fail closed on live admission at the moment of egress, after custody; same effect as the host guarded fetch.
  const guarded = { ...host, fetch: ((url, init) => host.admitted === true ? host.fetch(url, init) : Promise.reject(new Error("Admission withdrawn"))) as typeof host.fetch };
  const result = await requestLineAds({ dependencies: guarded, prepared: { configuration: required.input.configuration }, request: required.request }, optional);
  const { context, dependencies } = required.input;
  try { dependencies.observer.observe({ operation: "line-ads.deployment", outcome: result.ok ? "received" : result.error.code, correlationId: context.correlationId, traceId: context.traceId, runId: context.runId }); }
  catch { /* Telemetry cannot erase an acknowledged create. */ }
  return result;
}
function receipt(required: { references: References; hierarchy: unknown[]; status?: LineAdsDeploymentResult["status"] }): Outcome<LineAdsDeploymentResult> {
  return { ok: true, value: { ...required, status: required.status ?? "unknown", references: { ...required.references }, entityIds: Object.values(required.references) } };
}
