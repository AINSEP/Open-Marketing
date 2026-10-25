import { z } from "zod";
import { isDeepStrictEqual } from "node:util";
import { callContextSchema, idSchema } from "@open-marketing/contracts";
import type { CallContext, CallOptions, Outcome } from "@open-marketing/contracts";
import { vendorIdSchema, providerIdSchema } from "./commands.js";
import { campaignDeploymentPlanSchema } from "./campaign-translation.js";
import { configurationSchema, createAmazonAdsAdapter, requestDeployment } from "./transport.js";
import { failure } from "./ports.js";
import type { AmazonDependencies } from "./ports.js";

export { campaignDeploymentPlanSchema } from "./campaign-translation.js";
const steps = ["campaign", "group", "ad"] as const;
type Step = typeof steps[number];
const resources = { campaign: "campaigns", group: "adGroups", ad: "productAds" } as const;
const identifiers = { campaign: "campaignId", group: "adGroupId", ad: "adId" } as const;
const referencesSchema = z.strictObject({ campaign: vendorIdSchema.optional(), group: vendorIdSchema.optional(), ad: vendorIdSchema.optional() });
type References = z.infer<typeof referencesSchema>;
/** Receipt retains candidates on every stopped sequence; acknowledged means verified PAUSED. */
export interface AmazonDeploymentResult { status: "acknowledged" | "unknown"; entityIds: string[]; references: References; hierarchy: unknown[] }
type Checkpoint = (input: { step: string; phase: "dispatch" | "acknowledged"; references: References }) => Promise<Outcome<void>>;
interface Input { context: CallContext; operationId: string; plan: unknown; dependencies: AmazonDependencies; checkpoint: Checkpoint }
const inputSchema = z.strictObject({ context: callContextSchema, operationId: idSchema, plan: campaignDeploymentPlanSchema, configuration: configurationSchema });
type Checked = z.infer<typeof inputSchema> & Pick<Input, "dependencies">;

/** One finite PAUSED sequence under the owning grouped exact card/outbox. Host checkpoint must
 * reject repeated dispatch intents; fetch must recheck admission, scope, halt and exact authority.
 * @returns Verified hierarchy or unknown with every known reference; never retries or activates.
 * @example deployCampaignPaused({ context, operationId, plan, dependencies, checkpoint })
 * @complexity One profile GET, three creates and three filtered read-only POSTs; <=15s/1MiB each.
 */
export async function deployCampaignPaused(required: Input, optional?: CallOptions): Promise<Outcome<AmazonDeploymentResult>> {
  const checked = checkInput({ input: required });
  if (!checked.ok) return checked;
  const input = { ...checked.value, checkpoint: required.checkpoint };
  const profile = await verifyProfile({ input }, optional);
  if (!profile.ok) return profile;
  const references: References = {}; const hierarchy: unknown[] = [];
  for (const step of steps) {
    if (!await createStep({ input, step, references }, optional)) return receipt({ references, hierarchy });
    const row = await readStep({ input, step, references }, optional);
    if (!row.ok) return receipt({ references, hierarchy });
    hierarchy.push(row.value);
  }
  return receipt({ references, hierarchy, status: "acknowledged" });
}

/** Read saved IDs through Amazon's documented POST-list queries (read effects, not creates).
 * Missing/mismatched rows stop; all supplied references survive. No journal, discovery or resend.
 * @example readCampaignDeployment({ context, operationId, plan, dependencies, references })
 * @returns Verified PAUSED hierarchy or unknown; malformed input fails before credential access.
 * @complexity One profile GET and at most three filtered POST reads; <=15s/1MiB each, O(b) space.
 */
export async function readCampaignDeployment(required: Omit<Input, "checkpoint"> & { references: unknown }, optional?: CallOptions): Promise<Outcome<AmazonDeploymentResult>> {
  const checked = checkInput({ input: required });
  if (!checked.ok) return checked;
  const parsed = referencesSchema.safeParse(required.references);
  if (!parsed.success) return failure({ code: "invalid_input" });
  const references = parsed.data; const hierarchy: unknown[] = []; const input = checked.value;
  if (!references.campaign) return receipt({ references, hierarchy });
  if (!(await verifyProfile({ input }, optional)).ok) return receipt({ references, hierarchy });
  for (const step of steps) {
    const row = await readStep({ input, step, references }, optional);
    if (!row.ok) return receipt({ references, hierarchy });
    hierarchy.push(row.value);
  }
  return receipt({ references, hierarchy, status: "acknowledged" });
}

/** Bound and snapshot the entire plan/configuration before credentials or checkpoints. O(b), <=64KiB. */
function checkInput(required: { input: Omit<Input, "checkpoint"> }): Outcome<Checked> {
  const input = required.input;
  if (!input.dependencies.admitted) return failure({ code: "forbidden" });
  try {
    const json = JSON.stringify({ context: input.context, operationId: input.operationId, plan: input.plan, configuration: input.dependencies.configuration });
    if (Buffer.byteLength(json) > 65536) return failure({ code: "limit_exceeded" });
    const parsed = inputSchema.safeParse(JSON.parse(json) as unknown);
    if (!parsed.success) return failure({ code: "not_implemented" });
    const { context, configuration, plan } = parsed.data;
    if (!isDeepStrictEqual(context.scope, configuration.scope) || plan.profile.accountId !== configuration.accountId) return failure({ code: "forbidden" });
    const dependencies = { ...input.dependencies, get admitted() { return input.dependencies.admitted; }, configuration };
    return { ok: true, value: { ...parsed.data, dependencies } };
  } catch { return failure({ code: "invalid_input" }); }
}

/** Re-read profile currency, marketplace, timezone and seller/vendor type before dispatch. O(n), n<=100. */
async function verifyProfile(required: { input: Checked }, optional?: CallOptions): Promise<Outcome<void>> {
  const { input } = required;
  const result = await createAmazonAdsAdapter(input.dependencies).invoke({ context: input.context, operationId: input.operationId, command: { kind: "list_accounts" } }, optional);
  if (!result.ok) return result;
  const parsed = z.object({ items: z.array(z.object({ profileId: vendorIdSchema, countryCode: z.string(), currencyCode: z.string(), timezone: z.string(), accountInfo: z.object({ type: z.string() }) })).max(100) }).safeParse(result.value.data);
  if (!parsed.success) return failure({ code: "protocol_mismatch" });
  const row = parsed.data.items.find(item => item.profileId === input.configuration.accountId);
  const profile = input.plan.profile;
  if (!row || row.countryCode !== profile.country || row.currencyCode !== profile.currency || row.timezone !== profile.timezone || row.accountInfo.type !== input.plan.ad.product.type) return failure({ code: "conflict" });
  return { ok: true, value: undefined };
}

/** Journal intent first; retain an indexed candidate even on mixed errors/failed ACK checkpoints.
 * O(b) parsing; one create, no retry. A parent is substituted only after readStep verifies it.
 */
async function createStep(required: { input: Checked & Pick<Input, "checkpoint">; step: Step; references: References }, optional?: CallOptions): Promise<boolean> {
  const { input, step, references } = required;
  if (!input.dependencies.admitted || optional?.signal?.aborted) return false;
  if (!await checkpoint({ ...required, phase: "dispatch" })) return false;
  const response = await requestDeployment({ dependencies: input.dependencies, context: input.context, resource: resources[step], read: false, body: { [resources[step]]: [payload(required)] } }, optional);
  if (!response.ok || response.value.status !== 207) return false;
  const batch = z.object({ [resources[step]]: z.object({ success: z.array(z.object({ index: z.literal(0), [identifiers[step]]: providerIdSchema })).max(1).default([]), error: z.unknown().optional() }) }).safeParse(response.value.body);
  if (!batch.success) return false;
  const outcome = batch.data[resources[step]]!;
  const candidate = outcome.success[0]?.[identifiers[step]];
  if (typeof candidate !== "string") return false;
  references[step] = candidate;
  const saved = await checkpoint({ ...required, phase: "acknowledged" });
  return saved && (outcome.error === undefined || Array.isArray(outcome.error) && outcome.error.length === 0);
}

/** Fixed filtered list, ownership via scoped header and parent IDs. Compare all approved fields,
 * reject pagination/duplicates and return only projected configuration. O(b), one <=1MiB read.
 */
async function readStep(required: { input: Checked; step: Step; references: References }, optional?: CallOptions): Promise<Outcome<unknown>> {
  const { input, step, references } = required; const id = references[step];
  if (!id) return failure({ code: "protocol_mismatch" });
  const response = await requestDeployment({ dependencies: input.dependencies, context: input.context, resource: resources[step], read: true, body: { maxResults: 2, [identifiers[step] + "Filter"]: { include: [id] } } }, optional);
  if (!response.ok || response.value.status !== 200) return failure({ code: "protocol_mismatch" });
  const parsed = z.object({ [resources[step]]: z.array(z.record(z.string(), z.unknown())).length(1), nextToken: z.string().max(2048).nullish() }).safeParse(response.value.body);
  if (!parsed.success || parsed.data.nextToken) return failure({ code: "protocol_mismatch" });
  const rows = parsed.data[resources[step]];
  if (!Array.isArray(rows)) return failure({ code: "protocol_mismatch" });
  const row = rows[0]!;
  const observedId = providerIdSchema.safeParse(row[identifiers[step]]);
  const expected = payload(required);
  if (!observedId.success || observedId.data !== id || !Object.entries(expected).every(([key, value]) => isDeepStrictEqual(row[key], value))) return failure({ code: "protocol_mismatch" });
  return { ok: true, value: { ...expected, [identifiers[step]]: id } };
}

/** Only two acknowledged parent slots may change the approved request; no renaming/defaults. O(1). */
function payload(required: { input: Checked; step: Step; references: References }): Record<string, unknown> {
  const { plan } = required.input; const refs = required.references;
  switch (required.step) {
    case "campaign": return plan.campaign;
    case "group": return { ...plan.group, campaignId: refs.campaign };
    case "ad": { const { product, ...ad } = plan.ad; const { type: _type, ...identity } = product; return { ...ad, ...identity, campaignId: refs.campaign, adGroupId: refs.group }; }
  }
}
/** Host callback faults stop the sequence; a copy prevents mutation of retained references. O(1). */
async function checkpoint(required: { input: Checked & Pick<Input, "checkpoint">; step: Step; phase: "dispatch" | "acknowledged"; references: References }): Promise<boolean> {
  if (!required.input.dependencies.admitted) return false;
  try { return (await required.input.checkpoint({ step: required.step, phase: required.phase, references: { ...required.references } })).ok; }
  catch { return false; }
}
/** Copy known IDs on every partial path; no failed read can erase them. O(1), at most three IDs. */
function receipt(required: { references: References; hierarchy: unknown[]; status?: "acknowledged" }): Outcome<AmazonDeploymentResult> {
  return { ok: true, value: { ...required, status: required.status ?? "unknown", references: { ...required.references }, entityIds: Object.values(required.references) } };
}
