import { z } from "zod";
import { callContextSchema, campaignKeySchema, capabilityCatalog, idSchema, metricBatchSchema, parseBoundary, scopeSchema, serviceContextSchema } from "@open-marketing/contracts";
import type { CallContext, CallOptions, CampaignStatusOutput, CapabilityInput, CapabilityOutput, ClockPort, Outcome, PluginCapability, PluginCapabilityDependencies, PluginCapabilities, PluginCapabilitiesFactory, TrackingTagInput } from "@open-marketing/contracts";
import { createAudienceCapabilities } from "./audiences.js";
import { boundedJson, digest, failure, parse } from "./boundary.js";
import { vendorIdSchema } from "./commands.js";
import type { MetaBinding } from "./evidence.js";
import type { MetaInstagramDispatch } from "./instagram.js";
import { decodeMetrics, insightRowSchema, insightsParameters } from "./metrics.js";
import { adsGraphVersion, createConfiguredDispatch } from "./instagram-fetch.js";

const bindingSchema = z.strictObject({ scope: scopeSchema, connectionId: idSchema, accountId: vendorIdSchema });
type Dependencies = { binding: Pick<MetaBinding, "scope" | "connectionId" | "accountId">; dispatch: MetaInstagramDispatch; clock: ClockPort };
type Reads = { [K in "report.metrics.v1" | "campaign.status.v1" | "tracking.tag.v1"]: PluginCapability<K> };
const connectionSchema = campaignKeySchema.pick({ accountId: true }).extend({ connectionId: idSchema });
const accountSchema = z.object({ id: z.string().regex(/^act_[1-9][0-9]{0,31}$/), account_id: vendorIdSchema, currency: z.string().regex(/^[A-Z]{3}$/), timezone_name: metricBatchSchema.shape.timezone });
const pagingSchema = z.object({ next: z.string().min(1).max(8192).optional(), cursors: z.object({ after: z.string().min(1).max(2048) }).optional() }).optional();
const issue = z.object({ error_message: z.string().min(1).max(1000).optional(), error_summary: z.string().min(1).max(1000).optional() });
const budgetAmountSchema = z.union([z.literal("0"), z.string().regex(/^[1-9][0-9]{0,17}$/)]);
const metaTimeSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:[+-]\d{4}|Z)$/);
// Meta's minimum denomination differs from ISO currency exponents (including HUF and TWD).
const offsetOneCurrencies = ["CLP", "COP", "CRC", "HUF", "ISK", "IDR", "JPY", "KRW", "PYG", "TWD", "VND"];
const campaignSchema = z.object({ id: vendorIdSchema, account_id: vendorIdSchema, effective_status: z.string().min(1).max(100), issues_info: z.array(issue).max(20).nullish(),
  daily_budget: budgetAmountSchema.optional().catch(undefined), lifetime_budget: budgetAmountSchema.optional().catch(undefined), start_time: metaTimeSchema.optional().catch(undefined), stop_time: metaTimeSchema.optional().catch(undefined),
});
const feedback = z.record(z.string().max(100), z.string().min(1).max(1000));
const adSchema = z.object({ id: vendorIdSchema, account_id: vendorIdSchema, campaign_id: vendorIdSchema, effective_status: z.string().min(1).max(100), ad_review_feedback: z.object({ global: feedback.optional(), placement_specific: z.record(z.string().max(100), feedback).optional() }).nullish() });
const adsetSchema = z.object({ id: vendorIdSchema, account_id: vendorIdSchema, campaign_id: vendorIdSchema, promoted_object: z.object({ pixel_id: vendorIdSchema.optional() }).nullish() });
const pixelSchema = z.object({ id: vendorIdSchema, code: z.string().max(32768).optional() });
type ReadCall = (required: { edge: string; parameters: Record<string, string> }) => Promise<Outcome<unknown>>;

/** Canonical server ABI using the existing bounded Graph dispatch; no construction-time I/O.
 * Invalid configuration returns typed failures before credentials/fetch; no authority port.
 * @complexity O(1) setup; handlers share the bounded reader's per-invocation limits.
 * @example createCapabilities({ fetch, credentials, clock, observer, wait, configuration })
 */
export const createCapabilities = ((required: PluginCapabilityDependencies): Reads & PluginCapabilities => {
  const configured = createConfiguredDispatch(required);
  const audiences = createAudienceCapabilities({ configured });
  if (!configured.ok) return {
    "report.metrics.v1": async () => configured,
    "campaign.status.v1": async () => configured,
    "tracking.tag.v1": async () => configured,
    ...audiences,
  };
  const { configuration, dispatch } = configured.value;
  const { scope, connectionId, accountId } = configuration;
  return { ...createReadCapabilities({ binding: { scope, connectionId, accountId }, dispatch, clock: required.clock }), ...audiences };
}) satisfies PluginCapabilitiesFactory;

/** Bind the three inert read capabilities to server-owned dependencies; discovery grants no authority.
 * @param required - Trusted account binding, guarded dispatch and injected clock.
 * @returns Frozen PluginCapability functions; typed failures, no retries or write operations.
 * @example createReadCapabilities({ binding, dispatch, clock })
 * @complexity O(n) bounded projection; <=27 requests, <=30s, <=27MiB aggregate per invocation.
 */
export function createReadCapabilities(required: Dependencies): Reads {
  return {
    "report.metrics.v1": (input, options) => invokeRead({ dependencies: required, id: "report.metrics.v1", call: input }, options),
    "campaign.status.v1": (input, options) => invokeRead({ dependencies: required, id: "campaign.status.v1", call: input }, options),
    "tracking.tag.v1": (input, options) => invokeRead({ dependencies: required, id: "tracking.tag.v1", call: input }, options),
  };
}
/** One error boundary for a foreign dispatch; validate context, input and ownership before I/O. */
async function invokeRead<K extends keyof Reads>(required: { dependencies: Dependencies; id: K; call: Parameters<PluginCapability<K>>[0] }, optional?: CallOptions): Promise<Outcome<CapabilityOutput<K>>> {
  try {
    const { dependencies, call, id } = required;
    const context = boundContext({ binding: dependencies.binding, call });
    if (!context.ok) return context;
    const input = capabilityCatalog[id].input.safeParse(call.input);
    if (!input.success) return failure({ code: "invalid_input", message: "Invalid Meta read input" });
    const read = boundedReader({ dependencies, context: context.value, id, input: input.data }, optional);
    const result = await executeRead({ dependencies, read, input: input.data });
    if (!result.ok) return result;
    const output = capabilityCatalog[id].output.safeParse(result.value);
    if (!output.success) return failure({ code: "invalid_input", message: "Invalid Meta read output" });
    return { ok: true, value: output.data as CapabilityOutput<K> };
  } catch { return failure({ code: "unavailable", message: "Meta read boundary unavailable" }); }
}
function executeRead(required: { dependencies: Dependencies; read: ReadCall; input: CapabilityInput<keyof Reads> }): Promise<Outcome<unknown>> {
  if ("grain" in required.input) return readMetrics({ ...required, input: required.input });
  if ("vendorCampaignIds" in required.input) return readStatus({ ...required, ids: required.input.vendorCampaignIds });
  return readTag({ ...required, input: required.input });
}
/** Validate call context and its single connection against the configured account/scope before I/O.
 * Returns the normalized context or a constant typed failure; O(1) bounded schema work.
 * @example boundContext({ binding: { scope, connectionId, accountId }, call })
 */
export function boundContext(required: { binding: unknown; call: { context: unknown; connection: unknown } }): Outcome<CallContext> {
  const binding = parse({ schema: bindingSchema, input: required.binding });
  if (!binding.ok) return binding;
  const context = readContext({ value: required.call.context });
  if (!context.ok) return context;
  const connection = parse({ schema: connectionSchema, input: required.call.connection });
  if (!connection.ok) return connection;
  if (context.value.scope.ownerId !== binding.value.scope.ownerId || context.value.scope.workspaceId !== binding.value.scope.workspaceId || connection.value.connectionId !== binding.value.connectionId || connection.value.accountId !== binding.value.accountId) return failure({ code: "forbidden", message: "Meta read binding mismatch" });
  return context;
}
function readContext({ value }: { value: unknown }): Outcome<CallContext> {
  const service = serviceContextSchema.safeParse(value);
  if (!service.success) return parseBoundary({ schema: callContextSchema, input: value });
  const { serviceId, ...rest } = service.data;
  return parseBoundary({ schema: callContextSchema, input: { ...rest, principal: { kind: "service", serviceId } } });
}
/** Fresh per-invocation limits. Never follow paging.next, retain credentials, retry or perform per-item I/O.
 * The dispatch/fetch supplied by the host owns egress audit and trace instrumentation.
 * At most 27 responses of <=1 MiB each bound aggregate bytes to 27 MiB.
 */
function boundedReader(required: { dependencies: Dependencies; context: CallContext; id: keyof Reads; input: unknown }, optional?: CallOptions): ReadCall {
  const { dependencies, context } = required;
  const signal = AbortSignal.any([AbortSignal.timeout(30000), ...(optional?.signal ? [optional.signal] : [])]);
  const argumentsDigest = digest({ value: { capabilityId: required.id, input: required.input } });
  let requests = 0;
  return async input => {
    if (signal.aborted) return failure({ code: "cancelled", message: "Meta read cancelled or deadline exceeded" });
    if (requests >= 27) return failure({ code: "limit_exceeded", message: "Meta request limit exceeded" });
    requests += 1;
    const response = await dependencies.dispatch({ context, connectionId: dependencies.binding.connectionId, operationId: context.correlationId,
      effect: { operationId: context.correlationId, connectionId: dependencies.binding.connectionId, accountId: dependencies.binding.accountId, effects: ["read"], argumentsDigest, moneyExposure: null, requiredLimit: null },
      request: { method: "GET", endpoint: `https://graph.facebook.com/${adsGraphVersion}/act_${dependencies.binding.accountId}${input.edge}`, parameters: input.parameters }, timeoutMs: 15000,
    }, { signal });
    if (!response.ok) return response;
    if (signal.aborted) return failure({ code: "cancelled", message: "Meta read deadline exceeded" });
    return boundedJson({ input: response.value, maxBytes: 1048576 });
  };
}
/** Cursor-only pagination on a reconstructed account edge; terminal pages may still contain cursors.
 * @complexity O(n) time/space <=5,000 entities; total requests/bytes/deadline shared by all edges.
 */
async function pages<T>(required: { read: ReadCall; edge: string; parameters: Record<string, string>; schema: z.ZodType<T> }): Promise<Outcome<T[]>> {
  const schema = z.object({ data: z.array(required.schema).max(5001), paging: pagingSchema, error: z.never().optional() });
  const rows: T[] = [];
  const cursors = new Set<string>();
  let after: string | undefined;
  while (true) {
    const page = await readPage({ ...required, schema, after });
    if (!page.ok) return page;
    rows.push(...page.value.data);
    if (rows.length > 5000) return failure({ code: "limit_exceeded", message: "Meta row limit exceeded" });
    if (!page.value.paging?.next) return { ok: true, value: rows };
    after = page.value.paging.cursors?.after;
    if (!after || cursors.has(after)) return failure({ code: "invalid_input", message: "Invalid or repeated Meta cursor" });
    cursors.add(after);
  }
}
async function readPage<T>(required: { read: ReadCall; edge: string; parameters: Record<string, string>; schema: z.ZodType<T>; after?: string }): Promise<Outcome<T>> {
  const response = await required.read({ edge: required.edge, parameters: { ...required.parameters, limit: required.edge === "/insights" ? "200" : "500", ...(required.after ? { after: required.after } : {}) } });
  if (!response.ok) return response;
  return parse({ schema: required.schema, input: response.value });
}
/** Fetch and validate account metadata for metrics and status; one request within the invocation limit.
 * O(1), no caching; transport/parse/foreign-account failures remain typed.
 */
async function readAccount(required: { dependencies: Dependencies; read: ReadCall }): Promise<Outcome<z.infer<typeof accountSchema>>> {
  const account = await required.read({ edge: "", parameters: { fields: "id,account_id,currency,timezone_name" } });
  if (!account.ok) return account;
  const metadata = parse({ schema: accountSchema, input: account.value });
  if (!metadata.ok) return metadata;
  const binding = required.dependencies.binding;
  if (metadata.value.account_id !== binding.accountId || metadata.value.id !== "act_" + binding.accountId) return failure({ code: "forbidden", message: "Foreign Meta account metadata" });
  return metadata;
}
/** Reuse validated account facts before reading daily insights; existing bounds and decoding apply. */
async function readMetrics(required: { dependencies: Dependencies; read: ReadCall; input: Parameters<typeof insightsParameters>[0]["input"] }): Promise<Outcome<unknown>> {
  const metadata = await readAccount(required);
  if (!metadata.ok) return metadata;
  const binding = required.dependencies.binding;
  const rows = await pages({ read: required.read, edge: "/insights", parameters: insightsParameters({ input: required.input }), schema: insightRowSchema });
  if (!rows.ok) return rows;
  return decodeMetrics({ rows: rows.value, ...binding, currency: metadata.value.currency, timezone: metadata.value.timezone_name, input: required.input, retrievedAt: required.dependencies.clock.now({}) });
}
function filterIds({ ids }: { ids: string[] }): string { return JSON.stringify([{ field: "campaign.id", operator: "IN", value: ids }]); }
/** Read account facts and complete campaign/ad edges within the existing request/row bounds. */
async function readStatus(required: { dependencies: Dependencies; read: ReadCall; ids: string[] }): Promise<Outcome<unknown>> {
  if (required.ids.some(id => !vendorIdSchema.safeParse(id).success)) return failure({ code: "invalid_input", message: "Invalid Meta campaign ID" });
  const metadata = await readAccount(required);
  if (!metadata.ok) return metadata;
  const parameters = { filtering: filterIds({ ids: required.ids }), fields: "id,account_id,effective_status,issues_info,daily_budget,lifetime_budget,start_time,stop_time" };
  const campaigns = await pages({ read: required.read, edge: "/campaigns", parameters, schema: campaignSchema });
  if (!campaigns.ok) return campaigns;
  const ads = await pages({ read: required.read, edge: "/ads", parameters: { filtering: parameters.filtering, fields: "id,account_id,campaign_id,effective_status,ad_review_feedback" }, schema: adSchema });
  if (!ads.ok) return ads;
  if (campaigns.value.some(row => row.account_id !== required.dependencies.binding.accountId || !required.ids.includes(row.id))) return failure({ code: "forbidden", message: "Foreign Meta campaign" });
  if (ads.value.some(row => row.account_id !== required.dependencies.binding.accountId || !required.ids.includes(row.campaign_id))) return failure({ code: "forbidden", message: "Foreign Meta ad" });
  if (new Set(campaigns.value.map(row => row.id)).size !== campaigns.value.length || new Set(ads.value.map(row => row.id)).size !== ads.value.length) return failure({ code: "invalid_input", message: "Duplicate Meta status row" });
  const evidence = campaignReasons({ ads: ads.value });
  const observations = new Map(campaigns.value.map(row => [row.id, campaignObservation({ campaign: row, evidence: evidence.get(row.id), currency: metadata.value.currency })]));
  return { ok: true, value: { observedAt: required.dependencies.clock.now({}), complete: observations.size === required.ids.length,
    campaigns: required.ids.map(id => observations.get(id) ?? { vendorCampaignId: id, status: "unknown", disapprovalDescriptions: [] }),
  } };
}
/** Preserve campaign state/reasons while projecting optional budget and checked child evidence. */
function campaignObservation(required: { campaign: z.infer<typeof campaignSchema>; evidence?: { descriptions: string[]; rejectedChildAds: number }; currency: string }): unknown {
  const statuses: Record<string, string> = { ACTIVE: "active", PAUSED: "paused", CAMPAIGN_PAUSED: "paused", ARCHIVED: "ended", DELETED: "ended", PENDING_REVIEW: "pending", PREAPPROVED: "pending", DISAPPROVED: "disapproved" };
  const issues = required.campaign.issues_info?.flatMap(value => value.error_message ?? value.error_summary ?? []) ?? [];
  const budget = currentBudget({ campaign: required.campaign, currency: required.currency });
  return { vendorCampaignId: required.campaign.id, status: statuses[required.campaign.effective_status] ?? "unknown", disapprovalDescriptions: [...new Set([...issues, ...(required.evidence?.descriptions ?? [])])], rejectedChildAds: required.evidence?.rejectedChildAds ?? 0, ...(budget ? { currentBudget: budget } : {}) };
}
/** Scale Meta minimum-denomination text exactly; ambiguous/unset budgets and invalid flights are omitted.
 * O(1) bounded string/schema work; no ISO exponent lookup, floats, I/O or historical inference.
 */
function currentBudget({ campaign, currency }: { campaign: z.infer<typeof campaignSchema>; currency: string }): CampaignStatusOutput["campaigns"][number]["currentBudget"] {
  const daily = campaign.daily_budget === "0" ? undefined : campaign.daily_budget;
  const lifetime = campaign.lifetime_budget === "0" ? undefined : campaign.lifetime_budget;
  if (Boolean(daily) === Boolean(lifetime)) return undefined;
  const amountMicros = (daily ?? lifetime) + (offsetOneCurrencies.includes(currency) ? "000000" : "0000");
  const candidate = daily ? { kind: "daily", amountMicros, currency } : { kind: "lifetime", amountMicros, currency, flight: {
    start: Date.parse(campaign.start_time?.replace(/([+-]\d{2})(\d{2})$/, "$1:$2") ?? ""),
    end: Date.parse(campaign.stop_time?.replace(/([+-]\d{2})(\d{2})$/, "$1:$2") ?? ""),
  } };
  const checked = capabilityCatalog["campaign.status.v1"].output.shape.campaigns.element.shape.currentBudget.safeParse(candidate);
  return checked.success ? checked.data : undefined;
}
function reviewReasons({ ad }: { ad: z.infer<typeof adSchema> }): string[] {
  const review = ad.ad_review_feedback;
  return [...Object.values(review?.global ?? {}), ...Object.values(review?.placement_specific ?? {}).flatMap(value => Object.values(value))];
}
/** Count rejected ads and group their existing feedback once. O(a+r), <=5,000 ads, bounded feedback bytes. */
function campaignReasons({ ads }: { ads: z.infer<typeof adSchema>[] }): Map<string, { descriptions: string[]; rejectedChildAds: number }> {
  const evidenceByCampaign = new Map<string, { descriptions: string[]; rejectedChildAds: number }>();
  for (const ad of ads) {
    if (ad.effective_status !== "DISAPPROVED") continue;
    const evidence = evidenceByCampaign.get(ad.campaign_id) ?? { descriptions: [], rejectedChildAds: 0 };
    evidence.descriptions.push(...reviewReasons({ ad }));
    evidence.rejectedChildAds += 1;
    evidenceByCampaign.set(ad.campaign_id, evidence);
  }
  return evidenceByCampaign;
}
async function readTag(required: { dependencies: Dependencies; read: ReadCall; input: TrackingTagInput }): Promise<Outcome<unknown>> {
  const { campaignKey, destinationUrl } = required.input;
  if (campaignKey.pluginId !== "meta-ads" || campaignKey.accountId !== required.dependencies.binding.accountId) return failure({ code: "forbidden", message: "Meta tracking key mismatch" });
  if (!vendorIdSchema.safeParse(campaignKey.vendorCampaignId).success) return failure({ code: "invalid_input", message: "Invalid Meta campaign ID" });
  const adsets = await pages({ read: required.read, edge: "/adsets", parameters: { fields: "id,account_id,campaign_id,promoted_object", filtering: filterIds({ ids: [campaignKey.vendorCampaignId] }) }, schema: adsetSchema });
  if (!adsets.ok) return adsets;
  if (adsets.value.some(row => row.account_id !== campaignKey.accountId || row.campaign_id !== campaignKey.vendorCampaignId)) return failure({ code: "forbidden", message: "Foreign Meta tracking ad set" });
  const pixelIds = new Set(adsets.value.map(row => row.promoted_object?.pixel_id));
  if (pixelIds.size !== 1 || pixelIds.has(undefined)) return failure({ code: "unavailable", message: "Meta campaign pixel missing or ambiguous" });
  const pixels = await pages({ read: required.read, edge: "/adspixels", parameters: { fields: "id,code" }, schema: pixelSchema });
  if (!pixels.ok) return pixels;
  const matches = pixels.value.filter(row => pixelIds.has(row.id));
  if (matches.length !== 1 || !matches[0].code) return failure({ code: "unavailable", message: "Meta account pixel code unavailable" });
  const url = new URL(destinationUrl);
  url.searchParams.set("utm_source", "meta-ads"); url.searchParams.set("utm_medium", "paid");
  url.searchParams.set("om_a", campaignKey.accountId); url.searchParams.set("utm_id", "{{campaign.id}}");
  return { ok: true, value: { snippet: matches[0].code, campaignUrlTemplate: url.toString().replace("utm_id=%7B%7Bcampaign.id%7D%7D", "utm_id={{campaign.id}}") } };
}
