import { vi } from "vitest";
import type { CallContext } from "@open-marketing/contracts";
import { createVkAdsAdapter } from "../src/index.js";
import type { VkCredential, VkDependencies, VkInvocation, VkToken } from "../src/index.js";

/** Synthetic examples of documented fields; not a vendor recording or real credential. */
export const account = { id: 123, username: "fixture-user", currency: "RUB", status: "active" };
export const campaignPage = { count: 3, offset: 0, items: [{ id: 456, name: "Fixture campaign" }] };
export const context: CallContext = { scope: { ownerId: "owner", workspaceId: "workspace" }, principal: { kind: "owner", ownerId: "owner" }, correlationId: "correlation", traceId: "trace", runId: "run" };
export const report = { kind: "report" as const, since: "2026-10-01", until: "2026-10-31", ids: ["123"] };
export const retrievedAt = 1792800000000;
/** Valid invocation data; each call creates independent objects. */
export function invocation(required: { command?: VkInvocation["command"] } = {}): VkInvocation {
  return { context: structuredClone(context), operationId: "fixture-operation", command: required.command ?? { kind: "list_campaigns" } };
}
/** Synthetic server broker and strict URL router; no real credential or vendor call. */
export function fixture() {
  const state = { admitted: true };
  let stored: VkCredential = { accessToken: "SYNTHETIC_SECRET", expiresAt: retrievedAt + 86400000 };
  const credentials = {
    access: vi.fn(async () => ({ ok: true as const, value: stored })),
    save: vi.fn(async (input: { token: VkToken }) => {
      if ("clientId" in stored) stored = { ...stored, token: input.token };
      return { ok: true as const, value: undefined };
    }),
  };
  const fetch = vi.fn<typeof globalThis.fetch>(async (url, options) => {
    if (options?.method !== "GET") throw new Error("Unexpected fixture method");
    const token = "accessToken" in stored ? stored : stored.token;
    if (new Headers(options.headers).get("Authorization") !== "Bearer " + token?.accessToken) return new Response(null, { status: 401 });
    const path = new URL(String(url)).pathname;
    if (path === "/api/v3/user.json") return Response.json(account);
    if (path === "/api/v2/ad_plans.json") return Response.json(campaignPage);
    throw new Error("Unexpected fixture route");
  });
  const clock = { now: vi.fn(() => retrievedAt) };
  const observer = { observe: vi.fn() };
  const deadlineController = new AbortController();
  const deadline = vi.fn(() => deadlineController.signal);
  const configuration = { scope: structuredClone(context.scope), connectionId: "fixture-connection", accountId: "123" as string | null };
  const dependencies: VkDependencies = { get admitted() { return state.admitted; }, configuration, credentials, fetch, clock, observer, deadline };
  return { adapter: createVkAdsAdapter(dependencies), dependencies, state, configuration, credentials, fetch, clock, observer, deadline, deadlineController,
    setCredential(input: VkCredential) { stored = structuredClone(input); } };
}
