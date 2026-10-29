import { z } from "zod";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { callContextSchema, pluginConfigurationSchema, idSchema, parseBoundary } from "@open-marketing/contracts";
import type { CampaignDeploymentRequired, CampaignDeploymentReceipt, CallOptions, Outcome } from "@open-marketing/contracts";
import { boundTikTokJson, decodeTikTokAcknowledgement, decodeTikTokRead, digestTikTokArguments, encodeTikTokCommand, failure, tiktokCommandSchema, vendorIdSchema } from "./commands.js";
import type { TikTokCommand, TikTokReadCommand } from "./commands.js";
import type { TikTokEgressPort } from "./ports.js";
import { createTikTokCredentials, createTikTokFetchEgress } from "./transport.js";

/** Fixed parent slots; finite daily website traffic, one existing image/video plus cover. */
export const campaignDeploymentPlanSchema = z.strictObject({
  campaign: tiktokCommandSchema.options[5],
  adgroup: tiktokCommandSchema.options[6].extend({ campaignId: z.strictObject({ from: z.literal("campaign") }), scheduleEnd: z.string().regex(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/) }),
  ad: z.strictObject({ ...tiktokCommandSchema.options[7].shape, adgroupId: z.strictObject({ from: z.literal("adgroup") }), adFormat: z.enum(["SINGLE_IMAGE", "SINGLE_VIDEO"]), identityType: z.literal("CUSTOMIZED_USER"), imageIds: z.array(z.string().regex(/^[A-Za-z0-9_-]{1,256}$/)).length(1) }),
}).refine(validPlan);
export type TikTokPausedPlan = z.infer<typeof campaignDeploymentPlanSchema>;
/** Fingerprint uses the same emitted-schema algorithm as the command catalog. */
export const tiktokDeploymentSchemaFingerprint = createHash("sha256").update(JSON.stringify(z.toJSONSchema(campaignDeploymentPlanSchema))).digest("hex");
const steps = ["campaign", "adgroup", "ad"] as const;
type Step = typeof steps[number];
const referencesSchema = z.strictObject({ campaign: vendorIdSchema.optional(), adgroup: vendorIdSchema.optional(), ad: vendorIdSchema.optional() });
type References = z.infer<typeof referencesSchema>;
export type TikTokDeploymentResult = CampaignDeploymentReceipt & { references: References; hierarchy: unknown[] };
const inputSchema = z.strictObject({ context: callContextSchema, operationId: idSchema, connectionId: idSchema, accountId: vendorIdSchema, plan: z.unknown() });
type Checked = z.infer<typeof inputSchema> & { plan: TikTokPausedPlan } & { dependencies: { egress: TikTokEgressPort } };

/** Pure finite schedule and exact daily amount checks. Invalid calendar strings fail closed. O(1). */
function validPlan(required: { campaign: { budget: number }; adgroup: { budget: number; scheduleStart: string; scheduleEnd: string }; ad: { adFormat: string; videoId?: string } }): boolean {
  const { scheduleStart: start, scheduleEnd: end } = required.adgroup;
  const valid = [start, end].every(value => Number.isFinite(Date.parse(value.replace(" ", "T") + "Z")) && new Date(value.replace(" ", "T") + "Z").toISOString().slice(0, 19).replace("T", " ") === value);
  const creative = required.ad.adFormat === "SINGLE_IMAGE" ? required.ad.videoId === undefined : required.ad.videoId !== undefined;
  return valid && creative && start < end && start <= "2028-01-01 00:00:00" && end <= "2038-01-01 00:00:00" && required.campaign.budget === required.adgroup.budget;
}

/** Three writes inside the owning job; verify each disabled parent before its child.
 * @param required - Complete fixed plan, host-fenced egress and durable checkpoints.
 * @returns A receipt retaining every candidate ID on uncertainty, or not_implemented for an unsupported plan; never retries or activates.
 * @example deployCampaignPaused({ context, operationId, connectionId, accountId, plan, dependencies, checkpoint, saved })
 * @complexity Three creates + three filtered GETs; each transport <=15s/1MiB, O(b) decoding.
 */
export async function deployCampaignPaused(required: CampaignDeploymentRequired, optional?: CallOptions): Promise<Outcome<TikTokDeploymentResult>> {
  const checked = checkInput({ input: required });
  if (!checked.ok) return checked;
  const saved = required.saved;
  const refs = parseBoundary({ schema: referencesSchema, input: saved.references });
  if (!refs.ok) return refs;
  if (Object.keys(refs.value).length > 0 || saved.record !== null) return readCampaignDeployment(required, optional);
  const input = { ...checked.value, checkpoint: required.checkpoint };
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

/** Intent precedes dispatch; candidate ID precedes readback. Checkpoint faults stop. O(1) I/O. */
async function createStep(required: { input: Checked & Pick<CampaignDeploymentRequired, "checkpoint">; step: Step; references: References }, optional?: CallOptions): Promise<boolean> {
  const { input, step, references } = required;
  if (optional?.signal?.aborted || !await checkpoint({ input, step, phase: "dispatch", references })) return false;
  const command = creationCommand(required);
  if (!command.ok) return false;
  const response = await send({ input, request: command.value }, optional);
  if (!response.ok) return false;
  const ack = decodeTikTokAcknowledgement({ input: response.value });
  if (!ack.ok) return false;
  const candidate = step === "ad" ? z.array(vendorIdSchema).length(1).safeParse(ack.value.data.ad_ids) : vendorIdSchema.safeParse(ack.value.data[step + "_id"]);
  if (!candidate.success) return false;
  references[step] = Array.isArray(candidate.data) ? candidate.data[0] : candidate.data;
  return checkpoint({ input, step, phase: "acknowledged", references });
}

/** Saved-ID GETs only; missing parents/IDs never cause discovery or resubmission.
 * @param required - Original plan and saved references under current host authority.
 * @returns Acknowledged only when all three scoped configurations remain disabled, or not_implemented for an unsupported plan.
 * @example readCampaignDeployment({ context, operationId, connectionId, accountId, plan, dependencies, checkpoint, saved })
 * @complexity At most three filtered GETs, O(b) bounded response validation, no writes.
 */
export async function readCampaignDeployment(required: CampaignDeploymentRequired, optional?: CallOptions): Promise<Outcome<TikTokDeploymentResult>> {
  const checked = checkInput({ input: required });
  if (!checked.ok) return checked;
  const refs = parseBoundary({ schema: referencesSchema, input: required.saved.references });
  if (!refs.ok) return refs;
  const hierarchy: unknown[] = [];
  for (const step of steps) {
    const row = await readStep({ input: checked.value, step, references: refs.value }, optional);
    if (!row.ok) return receipt({ references: refs.value, hierarchy });
    hierarchy.push(row.value);
  }
  return receipt({ references: refs.value, hierarchy, status: "acknowledged" });
}

/** Compare flat GET configuration against the exact encoder output, including DISABLE. O(b). */
async function readStep(required: { input: Checked; step: Step; references: References }, optional?: CallOptions): Promise<Outcome<unknown>> {
  const { input, step, references } = required;
  const id = references[step];
  if (!id) return failure({ code: "protocol_mismatch", message: "TikTok saved ID missing" });
  const command = creationCommand(required);
  if (!command.ok) return command;
  const wire = encodeTikTokCommand({ input: command.value, accountId: input.accountId });
  if (!wire.ok || wire.value.method !== "POST") return failure({ code: "invalid_input", message: "TikTok plan is not a creation" });
  const reads = { campaign: { kind: "get-campaigns" as const, campaignIds: [id] }, adgroup: { kind: "get-adgroups" as const, adgroupIds: [id] }, ad: { kind: "get-ads" as const, adIds: [id] } };
  const request: TikTokReadCommand = { ...reads[step], page: 1, pageSize: 100 };
  const response = await send({ input, request }, optional);
  if (!response.ok) return response;
  const decoded = decodeTikTokRead({ input: response.value, command: request, accountId: input.accountId });
  if (!decoded.ok) return decoded;
  const rows = z.object({ data: z.object({ list: z.array(z.record(z.string(), z.unknown())).length(1) }) }).safeParse(decoded.value);
  const body = wire.value.body;
  const expected = step === "ad" ? { advertiser_id: input.accountId, campaign_id: references.campaign, adgroup_id: references.adgroup, ...(body.creatives as Record<string, unknown>[])[0] } : body;
  if (!rows.success || !Object.entries(expected).every(([key, value]) => isDeepStrictEqual(rows.data.data.list[0][key], value))) return failure({ code: "protocol_mismatch", message: "TikTok configuration or disabled status differs" });
  return { ok: true, value: rows.data.data.list[0] };
}

/** Validate the bounded envelope, then report unsupported plans before any effects.
 * @returns Typed binding/validation failure, not_implemented for plans outside the finite daily subset, or checked input.
 * @complexity O(b) time/space, b <= 1 MiB; no checkpoints, credentials or network.
 */
function checkInput(required: { input: CampaignDeploymentRequired }): Outcome<Checked> {
  const input = required.input;
  const bounded = boundTikTokJson({ input: { context: input.context, operationId: input.operationId, connectionId: input.connectionId, accountId: input.accountId, plan: input.plan } });
  if (!bounded.ok) return bounded;
  const parsed = parseBoundary({ schema: inputSchema, input: bounded.value });
  if (!parsed.ok) return parsed;
  const configuration = pluginConfigurationSchema.safeParse(input.dependencies.configuration);
  if (!configuration.success) return failure({ code: "invalid_input", message: "Invalid deployment configuration" });
  const binding = configuration.data;
  if (!isDeepStrictEqual({ connectionId: binding.connectionId, accountId: binding.accountId, scope: binding.scope }, { connectionId: input.connectionId, accountId: input.accountId, scope: parsed.value.context.scope })) return failure({ code: "forbidden", message: "Deployment binding mismatch" });
  const dependencies = { egress: createTikTokFetchEgress({ fetch: input.dependencies.fetch, credentials: createTikTokCredentials(input.dependencies), observer: input.dependencies.observer }) };
  const plan = parseBoundary({ schema: campaignDeploymentPlanSchema, input: parsed.value.plan });
  if (!plan.ok) return failure({ code: "not_implemented", message: "TikTok supports only finite daily website traffic with one existing image/video, cover and landing URL" });
  return { ok: true, value: { ...parsed.value, plan: plan.value, dependencies } };
}
/** Only two parent substitutions; deterministic names bind the owning operation. O(1), pure. */
function creationCommand(required: { input: Checked; step: Step; references: References }): Outcome<TikTokCommand> {
  const { input, references } = required;
  const marker = "om-" + digestTikTokArguments({ arguments: { operationId: input.operationId } }).slice(0, 32);
  const commands = { campaign: { ...input.plan.campaign, name: marker }, adgroup: { ...input.plan.adgroup, name: marker + "-group", campaignId: references.campaign }, ad: { ...input.plan.ad, name: marker + "-ad", adgroupId: references.adgroup } };
  return parseBoundary({ schema: tiktokCommandSchema, input: commands[required.step] });
}
/** Host journals immutable snapshots; opaque callback errors become a stopped sequence. O(1) I/O. */
async function checkpoint(required: { input: Checked & Pick<CampaignDeploymentRequired, "checkpoint">; step: Step; phase: "dispatch" | "acknowledged"; references: References }): Promise<boolean> {
  try { return (await required.input.checkpoint({ step: required.step, phase: required.phase, references: { ...required.references } })).ok; }
  catch { return false; }
}
/** Existing egress owns fresh credentials, final host fences, bounds and correlated telemetry. O(b). */
async function send(required: { input: Checked; request: TikTokCommand }, optional?: CallOptions): Promise<Outcome<unknown>> {
  const { input } = required;
  if (optional?.signal?.aborted) return failure({ code: "cancelled", message: "TikTok deployment cancelled" });
  try { return await input.dependencies.egress.send({ context: input.context, operationId: input.operationId, connectionId: input.connectionId, accountId: input.accountId, request: required.request, isCurrent: () => !optional?.signal?.aborted }, optional); }
  catch { return failure({ code: "unavailable", message: "TikTok deployment receipt unknown" }); }
}
/** Build paused-state evidence while retaining all known IDs on uncertainty. O(1), three IDs maximum. */
function receipt(required: { references: References; hierarchy: unknown[]; status?: TikTokDeploymentResult["status"] }): Outcome<TikTokDeploymentResult> { return { ok: true, value: { ...required, state: "paused", status: required.status ?? "unknown", references: { ...required.references }, entityIds: Object.values(required.references) } }; }
