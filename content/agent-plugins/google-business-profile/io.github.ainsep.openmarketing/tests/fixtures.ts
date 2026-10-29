/** Handwritten Google wire data, independent native double and scripted fetch; never live I/O. */
import { parseBoundary, pluginConfigurationSchema } from "@open-marketing/contracts";
import type { ObserverEvent, PluginCapabilityDependencies } from "@open-marketing/contracts";
import { createGoogleBusinessProfilePlugin } from "../src/plugin.ts";
import type { GoogleBusinessProfileDependencies, GoogleBusinessProfilePlugin } from "../src/plugin.ts";
import { dailyMetrics, locationInputSchema, performanceInputSchema } from "../src/schemas.ts";
import type { Binding, BusinessProfilePerformance, Context } from "../src/schemas.ts";
import { failure, sameScope } from "../src/transport.ts";

export const context: Context = { scope: { ownerId: "owner", workspaceId: "workspace" }, principal: { kind: "owner", ownerId: "owner" }, correlationId: "correlation", traceId: "trace", runId: "run" };
export const days = { start: "2026-09-30", end: "2026-10-02" };
export const binding: Binding = { scope: context.scope, connectionId: "connection", accountName: "accounts/100", locationName: "locations/200", reportingContext: { timezone: "America/Los_Angeles" } };
export const counts = ["3", "5", "7", "9007199254740993", "2", "3", "4"];
export function wire() {
  return { multiDailyMetricTimeSeries: [{ dailyMetricTimeSeries: dailyMetrics.map((dailyMetric, index) => ({ dailyMetric, timeSeries: { datedValues: [{ date: { year: 2026, month: 9, day: 30 }, value: counts[index] }] } })) }] };
}
export const native: BusinessProfilePerformance = { connectionId: binding.connectionId, locationName: binding.locationName, days, retrievedAt: Date.parse("2026-10-03T00:00:00Z"), rows: [
  { day: days.start, callClicks: "3", websiteClicks: "5", directionRequests: "7", views: "9007199254741002" },
  { day: "2026-10-01", callClicks: null, websiteClicks: null, directionRequests: null, views: null },
] };
/** Scripted fetch exercises the real REST codec and records every attempted request. */
export function fixture(required: { response?: unknown; fetch?: typeof fetch; binding?: Binding; credentials?: GoogleBusinessProfileDependencies["credentials"]; deadline?: GoogleBusinessProfileDependencies["deadline"] }) {
  const calls: { url: URL; init?: RequestInit }[] = [];
  const observations: ObserverEvent[] = [];
  const accesses: string[] = [];
  const dependencies: GoogleBusinessProfileDependencies = {
    binding: required.binding ?? binding, clock: { now: () => native.retrievedAt }, observer: { observe(event) { observations.push(event); } },
    deadline: required.deadline ?? { signal: ({ signal }) => signal ?? new AbortController().signal },
    credentials: required.credentials ?? { async access(input) { accesses.push(input.connectionId); return { ok: true, value: { accessToken: "fixture-token-never-real" } }; } },
    fetch: async (input, init) => {
      const url = new URL(String(input)); calls.push({ url, init });
      if (required.fetch) return required.fetch(input, init);
      if (init?.method === "POST") return Response.json(required.response ?? { name: "accounts/1/locations/2/localPosts/3", state: "LIVE" });
      if (url.pathname.includes("/accounts/")) return Response.json(url.searchParams.has("pageToken") ? { locations: [] } : { locations: [{ name: binding.locationName, title: "Fixture business" }], nextPageToken: "page-2" });
      return Response.json(required.response ?? wire());
    },
  };
  const capabilityDependencies: PluginCapabilityDependencies = { ...dependencies, configuration: pluginConfigurationSchema.parse({ scope: dependencies.binding.scope, connectionId: dependencies.binding.connectionId, accountId: "accounts/1/locations/2", pluginDigest: "a".repeat(64), settings: {} }),
    wait: async () => ({ ok: true, value: undefined }),
    credentials: { async access(input, options) {
      const credential = await dependencies.credentials.access({ context, connectionId: input.connectionId, signal: options?.signal ?? new AbortController().signal });
      return credential;
    } },
  };
  return { dependencies, capabilityDependencies, plugin: createGoogleBusinessProfilePlugin(dependencies), calls, observations, accesses };
}
/** Independent in-memory native read implementation for the shared read/scoping contract. */
export function memoryPlugin(): Pick<GoogleBusinessProfilePlugin, "listLocations" | "readPerformance"> {
  return {
    async listLocations(input) {
      const parsed = parseBoundary({ schema: locationInputSchema, input }); if (!parsed.ok) return parsed;
      if (!sameScope({ binding, context: input.context })) return failure({ code: "forbidden", message: "Scope mismatch" });
      if (input.pageToken) return { ok: true, value: { locations: [] } };
      return { ok: true, value: { locations: [{ name: binding.locationName, title: "Fixture business" }], nextPageToken: "page-2" } };
    },
    async readPerformance(input) {
      const parsed = parseBoundary({ schema: performanceInputSchema, input }); if (!parsed.ok) return parsed;
      if (!sameScope({ binding, context: input.context })) return failure({ code: "forbidden", message: "Scope mismatch" });
      return { ok: true, value: structuredClone(native) };
    },
  };
}
