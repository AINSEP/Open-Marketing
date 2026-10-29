/** Explicit stdio composition only; importing this module starts no services. */
import type { Readable, Writable } from "node:stream";
import { z } from "zod";
import { createMcpToolServer } from "@jini-ai/mcp";
import type { McpToolDef } from "@jini-ai/mcp";
import { parseBoundary } from "@open-marketing/contracts";
import { createGoogleBusinessProfilePlugin } from "./plugin.ts";
import type { GoogleBusinessProfileDependencies, GoogleBusinessProfilePlugin } from "./plugin.ts";
import { dailyMetrics, locationInputSchema, performanceInputSchema } from "./schemas.ts";
import type { Context } from "./schemas.ts";
import { failure } from "./transport.ts";

/** Publish only native reads. Foreign Jini callbacks validate arguments and forward cancellation.
 * O(1) construction, no I/O. Context is host-owned, outside model arguments.
 * These two object schemas generate object-valued properties; narrow Zod's broader
 * boolean-or-object JSON Schema property type at the published MCP boundary.
 * @example createReadTools({ plugin, context })
 */
export function createReadTools({ plugin, context }: { plugin: GoogleBusinessProfilePlugin; context: Context }): readonly McpToolDef[] {
  return [
    { name: "list_locations", description: "List one page of locations in the host-bound Google account.", annotations: { readOnlyHint: true }, inputSchema: z.toJSONSchema(locationInputSchema.omit({ context: true })) as McpToolDef["inputSchema"],
      async handler({ args, ctx }) {
        const input = parseBoundary({ schema: locationInputSchema, input: { ...args, context } });
        if (!input.ok) return input;
        return plugin.listLocations(input.value, { signal: ctx.signal });
      } },
    { name: "read_performance", description: "Read up to 366 days [start,end) for the host-bound location. Call clicks are not completed calls.", annotations: { readOnlyHint: true }, inputSchema: z.toJSONSchema(performanceInputSchema.omit({ context: true })) as McpToolDef["inputSchema"],
      async handler({ args, ctx }) {
        const input = parseBoundary({ schema: performanceInputSchema, input: { ...args, context } });
        if (!input.ok) return input;
        return plugin.readPerformance(input.value, { signal: ctx.signal });
      } },
  ];
}
/** Serve published Jini MCP tools until input closes. Default mode has no credentials/egress.
 * Returns 0 on closure, 1 on transport failure, 2 on invalid CLI arguments. O(1) setup.
 * @example await runCli({ args: ["--fixture"], stdin, stdout, stderr })
 */
export async function runCli(required: { args: string[]; stdin: Readable; stdout: Writable; stderr: Writable }): Promise<number> {
  const args = z.array(z.literal("--fixture")).max(1).safeParse(required.args);
  if (!args.success) { required.stderr.write("Usage: mcp-server.mjs [--fixture]\n"); return 2; }
  const context: Context = { scope: { ownerId: "fixture-owner", workspaceId: "fixture-workspace" }, principal: { kind: "owner", ownerId: "fixture-owner" }, correlationId: "fixture-correlation", traceId: "fixture-trace" };
  const plugin = createGoogleBusinessProfilePlugin(standaloneDependencies({ mode: args.data.length ? "fixture" : "unavailable", context }));
  try {
    const server = createMcpToolServer({ name: "google-business-profile", version: "0.1.0", tools: createReadTools({ plugin, context }), resolveBaseUrl: () => "https://unused.invalid" }, { stdin: required.stdin, stdout: required.stdout, fetchImpl: async () => { throw new Error("Daemon egress is unavailable"); } });
    await server.run({});
    return 0;
  } catch { required.stderr.write("GBP MCP transport unavailable\n"); return 1; }
}
/** Standalone fixture composition uses only handwritten data; default access fails before fetch. */
function standaloneDependencies({ mode, context }: { mode: "fixture" | "unavailable"; context: Context }): GoogleBusinessProfileDependencies {
  return {
    binding: { scope: context.scope, connectionId: "fixture-connection", accountName: "accounts/100", locationName: "locations/200" },
    clock: { now: () => 1790899200000 }, observer: { observe() {} },
    deadline: { signal({ timeoutMs, signal }) { const timeout = AbortSignal.timeout(timeoutMs); return signal ? AbortSignal.any([signal, timeout]) : timeout; } },
    credentials: { async access() {
      if (mode === "unavailable") return failure({ code: "unavailable", message: "Server GBP binding and OAuth are not configured" });
      return { ok: true, value: { accessToken: "fixture-token-never-real" } };
    } },
    fetch: async (url) => {
      if (String(url).includes("/accounts/")) return Response.json({ locations: [{ name: "locations/200", title: "Fixture business" }] });
      return Response.json({ multiDailyMetricTimeSeries: [{ dailyMetricTimeSeries: dailyMetrics.map(dailyMetric => ({ dailyMetric, timeSeries: { datedValues: [{ date: { year: 2026, month: 9, day: 30 }, value: "4" }] } })) }] });
    },
  };
}
