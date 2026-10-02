import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createSdkMcpTransport } from "../../index.js";
import type { TransportFixture } from "../contract/port-suites.js";
import type { FederationSdkSessionOpener } from "../../index.js";
import { protocolReply } from "./protocol.js";

/** Node's foreign request ABI is wrapped immediately into the owned two-object handler. */
async function handleHttp(required: { request: IncomingMessage; response: ServerResponse }): Promise<void> {
  if (required.request.method !== "POST") { required.response.writeHead(405).end(); return; }
  let body = "";
  for await (const chunk of required.request) {
    body += String(chunk);
    if (body.length > 100000) { required.response.writeHead(413).end(); return; }
  }
  const request = JSON.parse(body) as Parameters<typeof protocolReply>[0]["request"];
  const reply = protocolReply({ request });
  if (reply === null) { required.response.writeHead(202).end(); return; }
  required.response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(reply));
}

/** Real local loopback HTTP fixture; it starts only when a test calls this factory. */
export async function httpFixture(): Promise<TransportFixture> {
  const server = createServer((request, response) => { void handleHttp({ request, response }); });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture address unavailable");
  const opener: FederationSdkSessionOpener = {
    async open(input, options) {
      const client = new Client({ name: "om-fixture", version: "1.0.0" }, { capabilities: {} });
      const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}`), { fetch });
      await client.connect(transport, { timeout: input.timeoutMs, signal: options?.signal });
      return { ok: true, value: client };
    },
  };
  const port = createSdkMcpTransport({ opener, timeoutMs: 2000 });
  return { port, async cleanup() {
    await port.dispose({ connectionId: "fixture" });
    server.closeAllConnections();
    server.close();
    await once(server, "close");
  } };
}

/** Real child-process stdio fixture; injected process/configuration exists only in this test assembly. */
export async function stdioFixture(): Promise<TransportFixture> {
  const opener: FederationSdkSessionOpener = {
    async open(input, options) {
      const client = new Client({ name: "om-fixture", version: "1.0.0" }, { capabilities: {} });
      const transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL("./stdio-server.mjs", import.meta.url))], env: {}, stderr: "pipe" });
      await client.connect(transport, { timeout: input.timeoutMs, signal: options?.signal });
      return { ok: true, value: client };
    },
  };
  const port = createSdkMcpTransport({ opener, timeoutMs: 2000 });
  return { port, async cleanup() { await port.dispose({ connectionId: "fixture" }); } };
}
