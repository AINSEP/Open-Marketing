import type { CallContext, ObserverEvent } from "@open-marketing/contracts";
import { pluginConfigurationSchema } from "@open-marketing/contracts";
import { createMicrosoftAdsAdapter, createConversionDelivery, translateCampaign } from "../src/index.js";
import type { CampaignTranslationInput, DeploymentInput, MicrosoftAdsConversionDependencies, MicrosoftAdsConversionRequest, MicrosoftAdsDependencies, MicrosoftAdsInvocation, MicrosoftAdsWireRequest } from "../src/index.js";

export const now = Date.UTC(2026, 9, 12);
export const context: CallContext = { scope: { ownerId: "owner", workspaceId: "workspace" }, principal: { kind: "owner", ownerId: "owner" }, correlationId: "correlation", traceId: "trace", runId: "run" };
export const invocation = (required: { command?: MicrosoftAdsInvocation["command"] } = {}): MicrosoftAdsInvocation => ({ context, operationId: "operation", command: required.command ?? { kind: "list_campaigns" } });
export const campaignPage = { Campaigns: [{ Id: 456, Name: "Fixture", Status: "Paused", secret: "synthetic-secret" }] };
/** Independent synthetic GetCampaignsByIds success with the documented positional null error. */
export const campaignReadWithNullError = { Campaigns: [{ Id: 1001, Name: "Fixture traffic", CampaignType: "Search", Status: "Paused", BudgetType: "DailyBudgetStandard", DailyBudget: 12.34,
  TimeZone: "PacificTimeUSCanadaTijuana", BiddingScheme: { Type: "MaxClicks", MaxCpc: { Amount: 1.23 } } }], PartialErrors: [null] };
export const reportCommand = { kind: "report" as const, window: { start: now, end: now + 86400000 } };
export const tsv = "AccountId\tCampaignId\tTimePeriod\tCurrencyCode\tSpend\tImpressions\tClicks\tConversionsQualified\n123\t456\t2026-10-12\tUSD\t12.3400\t0\t0\t0.50\n";
/** Synthetic HTTP and archive effects only. T1 supplies a host gateway to the SAME dispatch suite. */
export function fixture() {
  const state = { admitted: true, bound: true, time: now, hook: (_input: { connectionId: string }) => {}, gatewayHook: (_input: { request: MicrosoftAdsWireRequest }) => {}, fetchHook: () => {}, downloadHook: () => {}, waitExtraMilliseconds: 0, responses: [campaignPage] as unknown[], text: tsv, files: 1, expanded: 0, compressed: 4, waits: 0, path: "report.tsv", kind: "file", declared: 0, archiveReads: 0 };
  const calls: { url: string; init: RequestInit }[] = [], credentials: string[] = [], downloads: unknown[] = [];
  const dispatches: Parameters<MicrosoftAdsDependencies["gateway"]["dispatch"]>[0][] = [];
  const timeouts: { milliseconds: number; deadline: number; controller: AbortController }[] = [];
  /** Deterministic host clock/timers: advancing time aborts due signals without real timers. */
  const advanceTime = (input: { milliseconds: number }) => {
    state.time += input.milliseconds;
    for (const timeout of timeouts) if (state.time >= timeout.deadline) timeout.controller.abort();
  };
  const observations: ObserverEvent[] = [];
  const denied = { ok: false as const, error: { code: "forbidden" as const, message: "Denied", retryable: false } };
  const dependencies: MicrosoftAdsDependencies = {
    configuration: { scope: context.scope, admitted: true, connectionId: "connection", accountId: "123", customerId: "234", currency: "USD", pluginDigest: "a".repeat(64), bindingId: "binding" },
    gateway: { async dispatch(input) { dispatches.push(input); state.gatewayHook(input); if (!state.admitted || !state.bound) return denied; return input.execute(); } },
    credentials: { async access(input) { if (!state.admitted || !state.bound) return denied; credentials.push(input.connectionId); state.hook(input); if (!state.admitted || !state.bound) return denied; return { ok: true, value: { accessToken: "synthetic-secret", expiresAt: state.time + 60000, secrets: { developerToken: "synthetic-secret" } } }; } },
    fetch: async (url, init) => { if (!state.admitted || !state.bound) throw new Error("Denied"); calls.push({ url: String(url), init: init! }); state.fetchHook(); init?.signal?.throwIfAborted(); return new Response(JSON.stringify(state.responses.shift()), { status: 200 }); },
    clock: { now: () => state.time }, observer: { observe: event => { observations.push(event); } },
    timeoutSignal: input => { const controller = new AbortController(); timeouts.push({ ...input, deadline: state.time + input.milliseconds, controller }); return controller.signal; },
    wait: async (input, options) => { state.waits++; advanceTime({ milliseconds: input.milliseconds + state.waitExtraMilliseconds }); options?.signal?.throwIfAborted(); },
    download: async (input, options) => { if (!state.admitted || !state.bound) return denied; downloads.push(input); state.downloadHook(); if (!state.admitted || !state.bound) return denied; options?.signal?.throwIfAborted(); return { ok: true, value: new Uint8Array(state.compressed) }; },
    archiveReader: { async *entries() { state.archiveReads++; for (let i = 0; i < state.files; i++) yield { kind: state.kind, entryPath: state.path, declaredSize: state.declared, async *openReadStream() { yield state.expanded ? new Uint8Array(state.expanded) : Buffer.from(state.text); } } as { kind: "file"; entryPath: string; openReadStream(): AsyncIterable<Uint8Array> }; } },
  };
  return { adapter: createMicrosoftAdsAdapter(dependencies), dependencies, state, calls, credentials, downloads, observations, dispatches, timeouts, advanceTime };
}
export type Fixture = ReturnType<typeof fixture>;
export function reportFixture() {
  const f = fixture();
  f.state.responses = [{ ReportRequestId: "report-id" }, { ReportRequestStatus: { Status: "Success", ReportDownloadUrl: "https://reports.example/report.zip" } }];
  return f;
}

/** Synthetic whole-day Pacific launch; expected dates/budgets are asserted independently in tests. */
export function translationInput(): CampaignTranslationInput {
  return { campaign: { name: "Fixture traffic", objective: "traffic", schedule: { window: { start: now + 7 * 3600000, end: now + 86400000 + 7 * 3600000 }, timezone: "America/Los_Angeles" }, audience: { countries: ["US"], searchTerms: ["fixture shoes", "fixture boots"] }, creativeIds: ["creative"], creativeDigest: "b".repeat(64) }, target: { accountId: "123", dailyBudget: { currency: "USD", minorUnits: 1234 } },
    resolved: { accountId: "123", currency: "USD", currencyExponent: 2, timezone: "America/Los_Angeles", creativeId: "creative", creativeDigest: "b".repeat(64), language: "English", maxCpc: { currency: "USD", minorUnits: 123 }, locations: [{ country: "US", id: "190" }], ad: { FinalUrls: ["https://example.com/shoes"], Headlines: ["Fixture shoes", "Find your pair", "Shop today"].map(Text => ({ Asset: { Type: "TextAsset", Text } })), Descriptions: ["Find your next pair of shoes.", "Browse our fixture collection today."].map(Text => ({ Asset: { Type: "TextAsset", Text } })) } } };
}
/** Real plugin transport with synthetic REST service and durable host checkpoint double. */
export function deploymentFixture() {
  const f = fixture();
  const translated = translateCampaign(translationInput());
  if (!translated.ok) throw new Error("Invalid deployment fixture");
  const state = { writes: 0, failWrite: 0, partialWrite: 0, checkpointFail: 0, checkpointCalls: 0, readHook: (_input: { path: string; rows: Record<string, unknown>[] }) => {}, beforeCheckpoint: () => {} };
  const rows = new Map<string, Record<string, unknown>[]>();
  const intents = new Set<string>(), checkpoints: { step: string; phase: string; references: Record<string, string> }[] = [];
  const shape: Record<string, { collection: string; ids: string }> = { Campaigns: { collection: "Campaigns", ids: "CampaignIds" }, CampaignCriterions: { collection: "CampaignCriterions", ids: "CampaignCriterionIds" }, AdGroups: { collection: "AdGroups", ids: "AdGroupIds" }, Keywords: { collection: "Keywords", ids: "KeywordIds" }, Ads: { collection: "Ads", ids: "AdIds" } };
  const input: DeploymentInput = { context, operationId: "launch", plan: translated.value, dependencies: { ...f.dependencies, fetch: async (url, init) => {
    if (!f.state.admitted || !f.state.bound) throw new Error("Denied");
    f.calls.push({ url: String(url), init: init! }); init?.signal?.throwIfAborted();
    const path = new URL(String(url)).pathname.split("/v13/")[1], collection = path.split("/")[0], definition = shape[collection], body = JSON.parse(String(init?.body));
    if (path.endsWith("/QueryByIds")) {
      const observed = structuredClone((rows.get(collection) ?? []).filter(row => body[definition.ids].map(String).includes(String(row.Id))));
      state.readHook({ path, rows: observed });
      return Response.json({ [definition.collection]: observed, PartialErrors: null });
    }
    state.writes++;
    if (state.writes === state.failWrite) throw new Error("synthetic-secret ambiguous");
    const created = (body[definition.collection] as Record<string, unknown>[]).map((row, index) => ({ ...row, ...(collection === "CampaignCriterions" ? { Status: "Active" } : {}), Id: state.writes * 1000 + index + 1 }));
    rows.set(collection, created);
    return Response.json({ [definition.ids]: created.map((row: { Id: number }) => row.Id), PartialErrors: state.writes === state.partialWrite ? [{ Code: 1, Message: "synthetic-secret" }] : null });
  } }, checkpoint: async event => {
    checkpoints.push(structuredClone(event)); state.checkpointCalls++; state.beforeCheckpoint();
    if (state.checkpointCalls === state.checkpointFail) return { ok: false, error: { code: "unavailable", message: "stop", retryable: false } };
    if (event.phase === "dispatch" && intents.has(event.step)) return { ok: false, error: { code: "conflict", message: "claimed", retryable: false } };
    if (event.phase === "dispatch") intents.add(event.step);
    return { ok: true, value: undefined };
  } };
  return { ...f, input, deploymentState: state, rows, checkpoints };
}
export type DeploymentFixture = ReturnType<typeof deploymentFixture>;

/** Existing measure service request with one synthetic authorized email digest. */
export function conversionInput(): MicrosoftAdsConversionRequest {
  return { context: { scope: context.scope, serviceId: "measure", correlationId: "correlation", traceId: "trace" }, deliveryId: "delivery", event: { eventId: "event", definitionId: "purchase", subjectId: "subject", occurredAt: now, destination: "microsoft-ads", purpose: "measurement", identifiers: { email: "a".repeat(64) }, identifierDigests: { email: "b".repeat(64) } },
    grant: { kind: "measurement", grantId: "grant", scope: context.scope, connectionId: "connection", accountId: "123", definitionIds: ["purchase"], destination: "microsoft-ads", purpose: "measurement", payloadSchema: "email-v1", payloadVersion: 1, expiresAt: now + 60000, revoked: false } };
}
/** Host authority double retains a dispatched claim after uncertainty; real host runs the same suite. */
export function conversionFixture() {
  const f = fixture(), claims = new Set<string>(), dispatches: unknown[] = [];
  const state = { consent: true, halted: false, doubleExecute: false, authorityHook: () => {} };
  f.state.responses = [{ PartialErrors: null }];
  const conversionConfiguration = { accountId: "123", customerId: "234", purpose: "measurement", payloadSchema: "email-v1", conversionGoals: { purchase: { name: "Existing purchase goal", createdAt: now - 7200000, enhancedConversionsEnabled: true } } };
  const dependencies: MicrosoftAdsConversionDependencies = { configuration: pluginConfigurationSchema.parse({ scope: context.scope, connectionId: "connection", accountId: "123", pluginDigest: "a".repeat(64), settings: { conversionConfiguration } }),
    credentials: f.dependencies.credentials, fetch: f.dependencies.fetch, clock: f.dependencies.clock, observer: f.dependencies.observer, wait: async () => ({ ok: true, value: undefined }),
    authority: { async dispatch(input, options) {
      dispatches.push(input); if (claims.has(input.deliveryId)) return { ok: true, value: { status: "unknown" } };
      if (!state.consent || state.halted) return { ok: false, error: { code: "forbidden", message: "Denied", retryable: false } };
      claims.add(input.deliveryId); state.authorityHook();
      const current = { isCurrent: () => state.consent && !state.halted && f.state.admitted && f.state.bound && !options?.signal?.aborted };
      const result = await input.execute(current);
      return state.doubleExecute ? input.execute(current) : result;
    } } };
  return { ...f, conversionState: state, conversionConfiguration, conversionDependencies: dependencies, conversionDispatches: dispatches, backend: createConversionDelivery(dependencies) };
}
export type ConversionFixture = ReturnType<typeof conversionFixture>;

/** Independent canonical report fixture; columns do not come from the encoder under test. */
export function metricsFixture(required: { grain: "account" | "campaign" | "ad_group" | "ad"; currency?: string }) {
  const f = reportFixture();
  f.state.time = Date.UTC(2026, 9, 13); // metric batches require dataThrough (window end, 2026-10-13) <= retrievedAt
  const headers = { account: "AccountId", campaign: "AccountId\tCampaignId", ad_group: "AccountId\tCampaignId\tAdGroupId", ad: "AccountId\tCampaignId\tAdGroupId\tAdId" };
  const ids = { account: "123", campaign: "123\t456", ad_group: "123\t456\t789", ad: "123\t456\t789\t1011" };
  const currency = required.currency ?? "USD";
  const dependencies = { ...f.dependencies, configuration: { ...f.dependencies.configuration, currency } };
  f.state.text = headers[required.grain] + "\tTimePeriod\tCurrencyCode\tSpend\tImpressions\tClicks\tConversionsQualified\tRevenue\n" + ids[required.grain] + "\t2026-10-12\t" + currency + "\t9007199254740993.000001\t0\t\t0.500000\t2.50\n";
  return { ...f, dependencies };
}
/** Exact requested campaign plus its scoped Search ad/keyword editorial evidence. */
export function statusFixture() {
  const f = fixture();
  f.state.responses = [
    { Campaigns: [{ Id: "456", CampaignType: "Search", Status: "Active" }], PartialErrors: [null] },
    { AdGroups: [{ Id: "789" }] },
    { Ads: [{ Id: "1011", EditorialStatus: "Disapproved" }] },
    { EditorialReasons: [{ AdGroupId: "789", AdOrKeywordId: "1011", Reasons: [{ ReasonCode: 12, Location: "Title" }] }], PartialErrors: [] },
    { Keywords: [{ Id: "1213", EditorialStatus: "Active" }] },
  ];
  return f;
}
