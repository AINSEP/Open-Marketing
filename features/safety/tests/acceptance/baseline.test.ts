import { expect, it } from "vitest";
import { createMemorySafetyRepo, createMemorySpendPolicy, createMemoryAccountDispatchLock } from "../../index.js";
import { timing } from "../fixtures.js";
const context = { scope: { ownerId: "owner", workspaceId: "workspace" }, principal: { kind: "owner" as const, ownerId: "owner" }, correlationId: "correlation", traceId: "trace" };
it("establishes a durable local halt", async () => {
 const repo = createMemorySafetyRepo(timing());
 const result = await repo.halt({ context, adAccountId: "account" });
 expect(result.ok).toBe(true);
 expect(await repo.snapshot({ context, accountId: "account" })).toMatchObject({ ok: true, value: { halted: true } });
});
it("admits a verified bounded read through the policy port", async () => {
 const policy = createMemorySpendPolicy({});
 expect(await policy.assess({ context, envelope: { operationId: "operation", connectionId: "connection", accountId: null, effects: ["read"], argumentsDigest: "a".repeat(64), moneyExposure: null, requiredLimit: null } })).toMatchObject({ ok: true, value: { allowed: true } });
});
it("provides a releasable account lock", async () => {
 const lock = createMemoryAccountDispatchLock(timing());
 const result = await lock.acquire({ context, accountId: "account" });
 expect(result.ok).toBe(true);
 if (!result.ok) throw new Error("lock failed");
 expect(await lock.release({ lockId: result.value.lockId })).toEqual({ ok: true, value: undefined });
});
