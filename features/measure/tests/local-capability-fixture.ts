import { once } from "node:events";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { afterEach } from "vitest";
import { z } from "zod";
import { appErrorSchema, callContextSchema, idSchema, parseBoundary } from "@open-marketing/contracts";
import type { Outcome } from "@open-marketing/contracts";
import { createMemoryConversionDelivery, createMemoryPlatformReporting } from "../index.js";
import type { ConversionDeliveryPort, PlatformMetricSnapshot, PlatformReportingPort } from "../index.js";
import { measureGrantSchema, resolvedConversionSchema, querySchema, serviceContextSchema } from "../src/rules.js";
import { snapshot } from "./fixtures.js";

const servers: Server[] = [];
afterEach(async () => {
  const closing = servers.splice(0).map(async server => {
    const closed = once(server, "close");
    server.closeAllConnections();
    server.close();
    await closed;
  });
  await Promise.all(closing);
});
const deliveryInputSchema = z.strictObject({ context: serviceContextSchema, event: resolvedConversionSchema, grant: measureGrantSchema, deliveryId: idSchema });
const requestSchema = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("deliver"), input: deliveryInputSchema }),
  z.strictObject({ action: z.literal("reconcile"), input: deliveryInputSchema }),
  z.strictObject({ action: z.literal("snapshot"), input: z.strictObject({ context: callContextSchema, query: querySchema }) }),
]);
type LocalState = { delivery: ConversionDeliveryPort; reports: PlatformReportingPort; traces: string[] };

/** Node's request/response callback ABI is kept in a thin wrapper. All JSON is
 * bounded and parsed before fixture capabilities; no provider, credential or spend.
 * @complexity O(b) bytes, capped at 32768; one capability call. */
async function respond(required: { request: IncomingMessage; response: ServerResponse; state: LocalState }): Promise<void> {
  try {
    const input = await readRequest({ request: required.request });
    const result = await execute({ input, state: required.state });
    required.response.setHeader("content-type", "application/json");
    required.response.end(JSON.stringify(result));
  } catch {
    required.response.statusCode = 400;
    required.response.end(JSON.stringify({ ok: false, error: { code: "invalid_input", message: "Local fixture request rejected", retryable: false } }));
  }
}
/** Foreign Node ABI: request and response are the two structural object arguments. */
function requestListener(required: { state: LocalState }): (request: IncomingMessage, response: ServerResponse) => void {
  return (request, response) => { void respond({ request, response, state: required.state }); };
}
async function readRequest(required: { request: IncomingMessage }): Promise<unknown> {
  if (required.request.method !== "POST" || required.request.url !== "/capability") throw new Error("Fixture route rejected");
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of required.request) {
    const value = Buffer.from(chunk);
    bytes += value.length;
    if (bytes > 32768) throw new Error("Fixture request size rejected");
    chunks.push(value);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
async function execute(required: { input: unknown; state: LocalState }): Promise<Outcome<unknown>> {
  const parsed = parseBoundary({ schema: requestSchema, input: required.input });
  if (!parsed.ok) return parsed;
  if (required.state.traces.length < 128) required.state.traces.push(parsed.value.input.context.traceId);
  switch (parsed.value.action) {
    case "deliver": return required.state.delivery.deliver(parsed.value.input);
    case "reconcile": return required.state.delivery.reconcile!(parsed.value.input);
    case "snapshot": return required.state.reports.snapshot(parsed.value.input);
    default: { const unreachable: never = parsed.value; throw new Error(String(unreachable)); }
  }
}
/** Actual loopback HTTP capability fixture for B1; servers are closed after each
 * test. Driver-specific HTTP code remains in tests, not the production core.
 * @complexity Bounded JSON requests; O(1) fixture construction. */
export async function createLocalCapabilityFixture(required: Record<string, never>) {
  const state: LocalState = { delivery: createMemoryConversionDelivery({}), reports: createMemoryPlatformReporting({ snapshot }), traces: [] };
  // Foreign Node listener ABI delegates immediately to the object-input handler.
  const server = createServer(requestListener({ state }));
  servers.push(server);
  const listening = once(server, "listening");
  server.listen(0, "127.0.0.1");
  await listening;
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Local fixture address unavailable");
  const url = "http://127.0.0.1:" + address.port + "/capability";
  async function request<T>(input: { action: string; input: unknown }): Promise<Outcome<T>> {
    const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input), signal: AbortSignal.timeout(2000) });
    const parsed = parseBoundary({ schema: z.discriminatedUnion("ok", [z.strictObject({ ok: z.literal(true), value: z.unknown() }), z.strictObject({ ok: z.literal(false), error: appErrorSchema })]), input: await response.json() });
    if (!parsed.ok) return parsed;
    return parsed.value as Outcome<T>;
  }
  const delivery: ConversionDeliveryPort = {
    deliver(input) { return request<{ status: "delivered" | "unknown" }>({ action: "deliver", input }); },
    reconcile(input) { return request<{ status: "delivered" | "unknown" }>({ action: "reconcile", input }); },
  };
  const reports: PlatformReportingPort = { snapshot(input) { return request<PlatformMetricSnapshot>({ action: "snapshot", input }); } };
  return { delivery, reports, traces: state.traces };
}
