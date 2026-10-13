import { defaultFederationMessages } from "@jini-ai/mcp/federation";
import { ScriptedMcpHttpExchange, ScriptedMcpStdioChannel } from "@jini-ai/mcp/federation/testing";
import { createJiniHttpMcpTransport, createJiniStdioMcpTransport } from "../../index.js";
import type { TransportFixture } from "../contract/port-suites.js";
import { protocolReply } from "./protocol.js";

/** Published Jini protocol double under the real HTTP client, with the same responses as loopback. */
export async function scriptedHttpFixture(): Promise<TransportFixture> {
  const exchange = new ScriptedMcpHttpExchange({ respond: ({ request }) => {
    if (!request.message) return { status: 204 };
    const reply = protocolReply({ request: request.message as Parameters<typeof protocolReply>[0]["request"] });
    return reply === null ? { status: 202 } : { body: reply };
  } });
  const port = createJiniHttpMcpTransport({ connectionId: "fixture", credentialReference: "broker-reference", timeoutMs: 2000,
    clientInfo: { name: "om-fixture", version: "1.0.0" }, exchange, spec: { url: "https://fixture.invalid/mcp", headers: {} }, bearerToken: () => undefined });
  return { port, cleanup: async () => { await port.dispose({ connectionId: "fixture" }); } };
}

/** Published Jini stdio double exercises real framing and handshake without a child process. */
export async function scriptedStdioFixture(): Promise<TransportFixture> {
  const port = createJiniStdioMcpTransport({ connectionId: "fixture", credentialReference: "broker-reference", timeoutMs: 2000,
    clientInfo: { name: "om-fixture", version: "1.0.0" }, openChannel: async () => new ScriptedMcpStdioChannel({ messages: defaultFederationMessages,
      respond: ({ message }) => protocolReply({ request: message as Parameters<typeof protocolReply>[0]["request"] }) ?? undefined }) });
  return { port, cleanup: async () => { await port.dispose({ connectionId: "fixture" }); } };
}
