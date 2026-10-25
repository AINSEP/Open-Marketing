import type { CallContext, ObserverEvent } from "@open-marketing/contracts";
import { createMicrosoftAdsAdapter } from "../src/index.js";
import type { MicrosoftAdsDependencies, MicrosoftAdsInvocation, MicrosoftAdsWireRequest } from "../src/index.js";

export const now = Date.UTC(2026, 9, 12);
export const context: CallContext = { scope: { ownerId: "owner", workspaceId: "workspace" }, principal: { kind: "owner", ownerId: "owner" }, correlationId: "correlation", traceId: "trace", runId: "run" };
export const invocation = (required: { command?: MicrosoftAdsInvocation["command"] } = {}): MicrosoftAdsInvocation => ({ context, operationId: "operation", command: required.command ?? { kind: "list_campaigns" } });
export const campaignPage = { Campaigns: [{ Id: 456, Name: "Fixture", Status: "Paused", secret: "synthetic-secret" }] };
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
    credentials: { async access(input) { if (!state.admitted || !state.bound) return denied; credentials.push(input.connectionId); state.hook(input); if (!state.admitted || !state.bound) return denied; return { ok: true, value: { accessToken: "synthetic-secret", expiresAt: now + 60000 } }; } },
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
