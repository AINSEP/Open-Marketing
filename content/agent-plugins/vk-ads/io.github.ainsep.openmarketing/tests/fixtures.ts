import { vi } from "vitest";
import type { CallContext } from "@open-marketing/contracts";
import { createVkAdsAdapter } from "../src/index.js";
import type { VkDependencies, VkInvocation } from "../src/index.js";

/** Synthetic examples of documented fields; not a vendor recording or real credential. */
export const account = { id: 123, username: "fixture-user", currency: "RUB", status: "active" };
export const campaignPage = { count: 3, offset: 0, items: [{ id: 456, name: "Fixture campaign" }] };
export const context: CallContext = { scope: { ownerId: "owner", workspaceId: "workspace" }, principal: { kind: "owner", ownerId: "owner" }, correlationId: "correlation", traceId: "trace", runId: "run" };
export const report = { kind: "report" as const, since: "2026-10-01", until: "2026-10-31" };
export const retrievedAt = 1792800000000;
/** Valid invocation data; each call creates independent objects. */
export function invocation(required: { command?: VkInvocation["command"] } = {}): VkInvocation {
  return { context: structuredClone(context), operationId: "fixture-operation", command: required.command ?? { kind: "list_campaigns" } };
}
/** Spies throw on every attempted effect; assertions require zero attempts, including after admission. */
export function fixture() {
  const state = { admitted: true };
  const credentials = { access: vi.fn(async () => { throw new Error("SYNTHETIC_SECRET_MUST_NOT_ESCAPE"); }) };
  const fetch = vi.fn<typeof globalThis.fetch>(async () => { throw new Error("Unexpected vendor egress"); });
  const clock = { now: vi.fn(() => retrievedAt) };
  const observer = { observe: vi.fn() };
  const configuration = { scope: structuredClone(context.scope), connectionId: "fixture-connection", accountId: "123" as string | null };
  const dependencies: VkDependencies = { get admitted() { return state.admitted; }, configuration, credentials, fetch, clock, observer };
  return { adapter: createVkAdsAdapter(dependencies), state, configuration, credentials, fetch, clock, observer };
}
