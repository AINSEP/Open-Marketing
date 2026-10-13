import type { Readable, Writable } from "node:stream";
import { createFixtureDependencies, fixtureBinding, fixtureContext } from "./fixture.ts";
import { createGooglePlugin } from "./plugin.ts";
import { createMcpSession, serveStdio } from "./mcp.ts";
import { createMemoryJournal } from "./memory.ts";
import { failure } from "./schema.ts";
import type { GooglePluginDependencies } from "./types.ts";

/** Explicit stdio composition root. Default launch is unavailable and performs no
 * vendor egress. --fixture opts into an isolated handwritten test account only.
 * The server host embeds createGooglePlugin for authenticated production adapters.
 * @example runCli({ args: [], stdin, stdout, stderr }) */
export async function runCli(required: { args: string[]; stdin: Readable; stdout: Writable; stderr: Writable }): Promise<number> {
  if (!validArgs({ args: required.args })) { required.stderr.write("Usage: mcp-server.mjs [--fixture]\n"); return 2; }
  const dependencies = required.args.length ? createFixtureDependencies({}) : unavailableDependencies({});
  const plugin = createGooglePlugin(dependencies);
  const session = createMcpSession({ plugin, context: fixtureContext });
  try {
    const result = await serveStdio({ stdin: required.stdin, stdout: required.stdout, session });
    if (!result.ok) { required.stderr.write(result.error.message + "\n"); return 1; }
    return 0;
  } catch { required.stderr.write("Google plugin transport closed unexpectedly\n"); return 1; }
}
function validArgs(required: { args: string[] }): boolean { return required.args.length === 0 || required.args.length === 1 && required.args[0] === "--fixture"; }
function unavailableDependencies(required: Record<string, never>): GooglePluginDependencies {
  return {
    binding: { ...fixtureBinding, mode: "read_only" }, journal: createMemoryJournal({ maxRecords: 1 }), clock: { now: () => 0 },
    transport: { async request() { return failure({ code: "unavailable", message: "Server host account/credential/authority bindings are not configured" }); } },
    authority: {
      async dispatch() { return failure({ code: "unavailable", message: "Host authority is unavailable" }); },
      async billing() { return failure({ code: "unavailable", message: "Billing evidence is unavailable" }); },
    },
  };
}
