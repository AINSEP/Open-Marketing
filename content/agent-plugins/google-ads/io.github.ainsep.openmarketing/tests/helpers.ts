import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { once } from "node:events";
import { createGooglePlugin } from "../src/plugin.ts";
import { createFixtureDependencies, createFixtureTransport, fixtureContext, fixtureTime } from "../src/fixture.ts";
import { createLocalMcpAdapter } from "../src/mcp.ts";
import { createGoogleRestTransport } from "../src/transport.ts";
import { failure, success } from "../src/schema.ts";
import type { GooglePlugin } from "../src/plugin.ts";
import type { SearchPlan } from "../src/types.ts";
import type { Outcome } from "@open-marketing/contracts";

export const plan: SearchPlan = {
  name: "Fixture Search", currency: "USD", averageDailyBudgetMicros: "10000000", cpcBidMicros: "1000000",
  startsAt: fixtureTime, endsAt: fixtureTime + 2 * 86400000, geoTargetIds: ["2840"],
  keywords: [{ text: "marketing tools", matchType: "EXACT" }],
  headlines: ["Open Marketing", "Plan Search Campaigns", "See Clear Reports"],
  descriptions: ["Plan bounded Search campaigns.", "Review every exact spend operation."],
  finalUrl: "https://example.test/landing", euPoliticalAdvertising: "DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING",
};
export interface Harness { plugin: Pick<GooglePlugin, "invoke">; close(): Promise<void> }
export async function memoryHarness(): Promise<Harness> {
  return { plugin: createGooglePlugin(createFixtureDependencies({})), async close() {} };
}
/** Real REST codec with an injected local fixture HTTP service; no vendor/network I/O. */
export async function restHarness(): Promise<Harness> {
  const fixture = createFixtureTransport({});
  const dependencies = createFixtureDependencies({});
  const transport = createGoogleRestTransport({ binding: dependencies.binding,
    credentials: { async access() { return success({ value: { accessToken: "fixture-token-never-real" } }); } },
    http: { async post(input) {
      const method = input.url.endsWith("googleAds:search") ? "search" : "mutate";
      const response = await fixture.transport.request({ method, body: JSON.parse(input.body), context: input.context, operationId: input.operationId });
      if (!response.ok) return response;
      return success({ value: { status: 200, body: response.value } });
    } },
  });
  return { plugin: createGooglePlugin({ ...dependencies, transport }), async close() {} };
}
/** Genuine private stdio subprocess adapter, with no npm resolution or runtime download. */
export async function stdioHarness(): Promise<Harness> {
  const entry = new URL("../bin/mcp-server.mjs", import.meta.url);
  const child = spawn(process.execPath, [entry.pathname, "--fixture"], { stdio: ["pipe", "pipe", "pipe"], env: { PATH: process.env.PATH ?? "" } });
  const pending = new Map<number, (value: unknown) => void>();
  let next = 0;
  const lines = createInterface({ input: child.stdout });
  lines.on("line", line => {
    const response = JSON.parse(line) as { id: number; result: unknown };
    const callback = pending.get(response.id);
    pending.delete(response.id);
    callback?.(response.result);
  });
  child.once("exit", () => { for (const resolve of pending.values()) resolve(undefined); pending.clear(); });
  async function rpc(required: { method: string; params: unknown }): Promise<unknown> {
    next += 1;
    const requestId = next;
    const response = new Promise<unknown>(resolve => pending.set(requestId, resolve));
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: requestId, ...required }) + "\n");
    return response;
  }
  await rpc({ method: "initialize", params: { protocolVersion: "2025-06-18", clientInfo: { name: "fixture-client", version: "1" }, capabilities: {} } });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  const plugin = createLocalMcpAdapter({ context: fixtureContext, client: { async call(input) {
    const result = await rpc({ method: "tools/call", params: input });
    if (!result) return failure({ code: "unavailable", message: "Fixture stdio exited" });
    return success({ value: result });
  } } });
  return { plugin, async close() {
    const exited = once(child, "close");
    child.stdin.end();
    await exited;
    lines.close();
  } };
}
export function value<T>(required: { outcome: Outcome<unknown> }): T {
  if (!required.outcome.ok) throw new Error(required.outcome.error.code + ": " + required.outcome.error.message);
  return required.outcome.value as T;
}
