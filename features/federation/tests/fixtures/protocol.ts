/** Local fixture protocol uses no credentials, vendor SDK or external effect. */
export function protocolReply(required: { request: { id?: string | number; method: string; params?: { arguments?: Record<string, unknown>; _meta?: unknown } } }): unknown {
  const request = required.request;
  if (request.id === undefined) return null;
  if (request.method === "initialize") return { jsonrpc: "2.0", id: request.id, result: { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "federation-local-fixture", version: "1.0.0" } } };
  const args = request.params?.arguments ?? {};
  const metadata = request.params?._meta;
  if (args.query === "unknown") return { jsonrpc: "2.0", id: request.id, error: { code: -32603, message: "fixture uncertainty" } };
  return { jsonrpc: "2.0", id: request.id, result: fixtureResult({ arguments: args, metadata }) };
}
function fixtureResult(required: { arguments: Record<string, unknown>; metadata: unknown }): unknown {
  switch (required.arguments.query) {
    case "oversized": return { content: [{ type: "text", text: "x".repeat(262145) }] };
    case "invalid": return { content: [{ type: "resource_link", uri: "file:///secret", name: "secret" }] };
    case "tainted": return { content: [{ type: "text", text: 42 }] };
    default: return { content: [{ type: "text", text: JSON.stringify(required) }], structuredContent: { echo: required.arguments.query }, _meta: { vendorSecret: "must be stripped", vendorConfiguration: "must be stripped" } };
  }
}
