import { z } from "zod";
import { isDeepStrictEqual } from "node:util";
import { callContextSchema, idSchema } from "@open-marketing/contracts";
import type { CallContext, CallOptions, Outcome } from "@open-marketing/contracts";
import { vendorId } from "./commands.js";
import { campaignDeploymentPlanSchema } from "./campaign-translation.js";
import { failure } from "./ports.js";
import type { PinterestDependencies, PinterestWriteRequest } from "./ports.js";
import { boundInput, configurationSchema, requestPinterest, resolveCredential } from "./transport.js";

const steps = ["campaign", "adGroup", "ad"] as const;
type Step = typeof steps[number];
const paths = { campaign: "campaigns", adGroup: "ad_groups", ad: "ads" };
const referencesSchema = z.strictObject({ campaign: vendorId.optional(), adGroup: vendorId.optional(), ad: vendorId.optional() });
/** Candidate IDs are recovery evidence, never proof of successful creation/readback. */
export type PinterestDeploymentReferences = z.infer<typeof referencesSchema>;
/** Unknown always stops; the host retains references in its one durable jobs outbox. */
export interface PinterestDeploymentResult { status: "acknowledged" | "unknown"; entityIds: string[]; references: PinterestDeploymentReferences; hierarchy: unknown[] }
/** Host must atomically reject any previously dispatched step for this operationId/frozen plan.
 * Its guarded fetch rechecks exact approval, admission, account and halt after token lookup.
 */
type Checkpoint = (required: { step: string; phase: "dispatch" | "acknowledged"; references: PinterestDeploymentReferences }) => Promise<Outcome<void>>;
interface Input { context: CallContext; operationId: string; plan: unknown; dependencies: Omit<PinterestDependencies, "gateway">; checkpoint: Checkpoint }
const inputSchema = z.strictObject({ context: callContextSchema, operationId: idSchema, plan: campaignDeploymentPlanSchema, configuration: configurationSchema });
type Checked = z.infer<typeof inputSchema> & Pick<Input, "dependencies">;

/** Create one explicitly PAUSED hierarchy inside the already approved host job; no nested policy/outbox.
 * @param required - Frozen complete plan, guarded dependencies and durable dispatch checkpoints.
 * @returns Typed preflight denial or receipt retaining known IDs on every interrupted outcome.
 * @example deployCampaignPaused({ context, operationId, plan, dependencies, checkpoint })
 * @complexity Three singleton POSTs + three GETs at most; each <=15s/1MiB, no retry/activation.
 */
export async function deployCampaignPaused(required: Input, optional?: CallOptions): Promise<Outcome<PinterestDeploymentResult>> {
  const checked = checkInput({ input: required });
  if (!checked.ok) return checked;
  if (typeof required.checkpoint !== "function") return failure({ code: "invalid_input" });
  const input = { ...checked.value, checkpoint: required.checkpoint };
  const references: PinterestDeploymentReferences = {}, hierarchy: unknown[] = [];
  for (const step of steps) {
    if (!await createStep({ input, step, references }, optional)) return receipt({ references, hierarchy });
    const row = await readStep({ input, step, references }, optional);
    if (!row.ok) return receipt({ references, hierarchy });
    hierarchy.push(row.value);
  }
  return receipt({ references, hierarchy, status: "acknowledged" });
}

/** Journal intent before egress and any candidate ID before checking item errors; failure stops successors. O(b). */
async function createStep(required: { input: Checked & Pick<Input, "checkpoint">; step: Step; references: PinterestDeploymentReferences }, optional?: CallOptions): Promise<boolean> {
  const { input, step, references } = required;
  if (optional?.signal?.aborted) return false;
  if (!await checkpoint({ ...required, phase: "dispatch" })) return false;
  const response = await send({ input, request: { url: endpoint({ input, step }), method: "POST", body: JSON.stringify([creationBody(required)]) } }, optional);
  if (!response.ok) return false;
  const candidate = z.object({ items: z.array(z.object({ data: z.object({ id: vendorId }) })).length(1) }).safeParse(response.value.body);
  if (!candidate.success) return false;
  references[step] = candidate.data.items[0].data.id;
  if (!await checkpoint({ ...required, phase: "acknowledged" })) return false;
  const acknowledgement = z.strictObject({ items: z.array(z.strictObject({ data: z.object({ id: vendorId }), exceptions: z.union([z.array(z.unknown()).length(0), z.null()]).optional() })).length(1) }).safeParse(response.value.body);
  return response.value.status === 200 && acknowledgement.success;
}

/** Saved-reference reconciliation only: no scans, create, resend or continuation.
 * @param required - Original plan, current guarded dependencies and saved candidate IDs.
 * @returns Acknowledged only after all three exact scoped PAUSED readbacks; otherwise retained unknown.
 * @example readCampaignDeployment({ context, operationId, plan, dependencies, references })
 * @complexity At most three <=15s/1MiB GETs; missing references cause zero writes.
 */
export async function readCampaignDeployment(required: Omit<Input, "checkpoint"> & { references: unknown }, optional?: CallOptions): Promise<Outcome<PinterestDeploymentResult>> {
  const checked = checkInput({ input: required });
  if (!checked.ok) return checked;
  const bounded = boundInput({ input: required.references });
  if (!bounded.ok) return bounded;
  const parsed = referencesSchema.safeParse(bounded.value);
  if (!parsed.success) return failure({ code: "invalid_input" });
  const references = parsed.data, hierarchy: unknown[] = [];
  for (const step of steps) {
    const row = await readStep({ input: checked.value, step, references }, optional);
    if (!row.ok) return receipt({ references, hierarchy });
    hierarchy.push(row.value);
  }
  return receipt({ references, hierarchy, status: "acknowledged" });
}

/** Verify exact consumed fields, account, parent, manual bid, country set, budget, schedule and Pin. O(b). */
async function readStep(required: { input: Checked; step: Step; references: PinterestDeploymentReferences }, optional?: CallOptions): Promise<Outcome<unknown>> {
  const { input, step, references } = required;
  const id = references[step];
  if (!id) return failure({ code: "protocol_mismatch" });
  const response = await send({ input, request: { method: "GET", url: endpoint({ input, step }) + "/" + id } }, optional);
  if (!response.ok) return response;
  const row = z.record(z.string(), z.unknown()).safeParse(response.value.body);
  const expected = { ...creationBody(required), id, ad_account_id: input.plan.accountId };
  if (response.value.status !== 200 || !row.success) return failure({ code: "protocol_mismatch" });
  if (!Object.entries(expected).every(([key, value]) => isDeepStrictEqual(row.data[key], value))) return failure({ code: "protocol_mismatch" });
  return { ok: true, value: expected };
}
/** Complete snapshot/closed schema and binding checks before checkpoints/credentials. O(b), <=64KiB. */
function checkInput(required: { input: Omit<Input, "checkpoint"> }): Outcome<Checked> {
  const input = required.input;
  if (!input.dependencies.admitted) return failure({ code: "forbidden" });
  const bounded = boundInput({ input: { context: input.context, operationId: input.operationId, plan: input.plan, configuration: input.dependencies.configuration } });
  if (!bounded.ok) return bounded;
  const parsed = inputSchema.safeParse(bounded.value);
  if (!parsed.success) return failure({ code: "not_implemented" });
  const { plan, configuration, context } = parsed.data;
  if (!isDeepStrictEqual(context.scope, configuration.scope)) return failure({ code: "forbidden" });
  if (plan.accountId !== configuration.accountId || plan.currency !== configuration.currency) return failure({ code: "conflict" });
  return { ok: true, value: { ...parsed.data, dependencies: { ...input.dependencies, configuration } } };
}
/** Only acknowledged parent slots are substituted; names remain those on the frozen exact card. O(1). */
function creationBody(required: { input: Checked; step: Step; references: PinterestDeploymentReferences }): Record<string, unknown> {
  const { input, step, references } = required;
  switch (step) {
    case "campaign": return { ...input.plan.campaign, ad_account_id: input.plan.accountId };
    case "adGroup": return { ...input.plan.adGroup, campaign_id: references.campaign };
    case "ad": return { ...input.plan.ad, ad_group_id: references.adGroup };
    default: { const exhaustive: never = step; return exhaustive; }
  }
}
function endpoint(required: { input: Checked; step: Step }): string { return "https://api.pinterest.com/v5/ad_accounts/" + required.input.plan.accountId + "/" + paths[required.step]; }
/** Snapshot journal records; opaque persistence failures cannot discard locally held candidate IDs. O(1). */
async function checkpoint(required: { input: Checked & Pick<Input, "checkpoint">; step: Step; phase: "dispatch" | "acknowledged"; references: PinterestDeploymentReferences }): Promise<boolean> {
  try { return (await required.input.checkpoint({ step: required.step, phase: required.phase, references: { ...required.references } })).ok; }
  catch { return false; }
}
/** Credential lookup precedes host-fenced fetch; all failures after intent become unknown receipts. O(b). */
async function send(required: { input: Checked; request: PinterestWriteRequest }, optional?: CallOptions): Promise<Outcome<{ status: number; body: unknown }>> {
  const { input } = required;
  const credential = await resolveCredential({ dependencies: input.dependencies }, optional);
  if (!credential.ok) return credential;
  return requestPinterest({ ...required, dependencies: input.dependencies, context: input.context, credential: credential.value, isCurrent: () => input.dependencies.admitted }, optional);
}
function receipt(required: { references: PinterestDeploymentReferences; hierarchy: unknown[]; status?: PinterestDeploymentResult["status"] }): Outcome<PinterestDeploymentResult> {
  return { ok: true, value: { ...required, status: required.status ?? "unknown", references: { ...required.references }, entityIds: Object.values(required.references) } };
}
