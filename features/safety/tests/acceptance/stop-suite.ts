import { describe, expect, it } from "vitest";
import { digestArguments } from "../../index.js";
import type { HaltStopRequest } from "@open-marketing/contracts";
import { context, createHarness, pluginDigest, unwrap } from "../fixtures.js";
/** Typed halt-stop capability cannot inflate into arbitrary mutations. */
export function stopSuite(required: { backend: "memory" | "sql" }) {
 describe(`${required.backend} halt-stop acceptance`, () => {
  it.each(["pause", "stop"] as const)("allows verified backend %s of existing scoped entities after halt", async action => {
   const harness = createHarness(required);
   const halt = unwrap({ outcome: await harness.service().haltAccount({ context, adAccountId: "account" }) });
   const backend = { scope: context.scope, serviceId: "halt-worker", correlationId: "halt-correlation", traceId: "trace", runId: "halt-run" };
   const args = { adAccountId: "account", entityIds: ["existing-campaign"], action };
   const request: HaltStopRequest = { ...args, operationId: "stop-operation", scope: context.scope, connectionId: "connection", haltId: halt.haltId, haltEpoch: halt.epoch, pluginDigest, bindingId: "verified-stop", argumentsDigest: unwrap({ outcome: digestArguments({ arguments: args }) }) };
   const service = harness.service({ stops: [{ context: backend, request }] });
   const permit = unwrap({ outcome: await service.authorizeHaltStop({ context: backend, request }) });
   expect(permit.kind).toBe("halt-stop");
   expect(permit.request).toEqual(request);
   expect(await harness.repo.snapshot({ context, accountId: "account" })).toMatchObject({ ok: true, value: { halted: true } });
   expect(harness.audit.read({}).at(-1)).toMatchObject({ context: { correlationId: "halt-correlation", runId: "halt-run" }, outcome: "halt_stop_admitted" });
   harness.close();
  });
  it.each([
   { label: "activation", change: { action: "activate" } },
   { label: "budget inflation", change: { budget: 1000 } },
   { label: "arbitrary arguments", change: { arguments: { activate: true } } },
   { label: "empty entity list", change: { entityIds: [] } },
   { label: "oversized entity list", change: { entityIds: Array.from({ length: 101 }, () => "entity") } },
  ])("rejects $label before issuing a permit", async ({ change }) => {
   const harness = createHarness(required);
   const halt = unwrap({ outcome: await harness.service().haltAccount({ context, adAccountId: "account" }) });
   const backend = { scope: context.scope, serviceId: "halt-worker", correlationId: "halt-correlation", traceId: "trace", runId: "halt-run" };
   const args = { adAccountId: "account", entityIds: ["existing-campaign"], action: "pause" as const };
   const valid: HaltStopRequest = { ...args, operationId: "stop-operation", scope: context.scope, connectionId: "connection", haltId: halt.haltId, haltEpoch: halt.epoch, pluginDigest, bindingId: "verified-stop", argumentsDigest: unwrap({ outcome: digestArguments({ arguments: args }) }) };
   const service = harness.service({ stops: [{ context: backend, request: valid }] });
   expect((await service.authorizeHaltStop({ context: backend, request: { ...valid, ...change } as unknown as HaltStopRequest })).ok).toBe(false);
   harness.close();
  });
  it("rejects stale halt epoch, forged digest, unverified entities, and agent service spoofing", async () => {
   const harness = createHarness(required);
   const halt = unwrap({ outcome: await harness.service().haltAccount({ context, adAccountId: "account" }) });
   const backend = { scope: context.scope, serviceId: "halt-worker", correlationId: "halt-correlation", traceId: "trace", runId: "halt-run" };
   const args = { adAccountId: "account", entityIds: ["existing-campaign"], action: "pause" as const };
   const valid: HaltStopRequest = { ...args, operationId: "stop-operation", scope: context.scope, connectionId: "connection", haltId: halt.haltId, haltEpoch: halt.epoch, pluginDigest, bindingId: "verified-stop", argumentsDigest: unwrap({ outcome: digestArguments({ arguments: args }) }) };
   const stale = { ...valid, haltEpoch: valid.haltEpoch + 1 };
   const forged = { ...valid, argumentsDigest: "f".repeat(64) };
   const service = harness.service({ stops: [{ context: backend, request: valid }, { context: backend, request: stale }, { context: backend, request: forged }] });
   expect((await service.authorizeHaltStop({ context: backend, request: stale })).ok).toBe(false);
   expect((await service.authorizeHaltStop({ context: backend, request: forged })).ok).toBe(false);
   expect((await service.authorizeHaltStop({ context: backend, request: { ...valid, entityIds: ["unverified-campaign"] } })).ok).toBe(false);
   expect((await service.authorizeHaltStop({ context: { ...backend, serviceId: "agent" }, request: valid })).ok).toBe(false);
   harness.close();
  });
  it("a verified stop mapping cannot operate without a local halt", async () => {
   const harness = createHarness(required);
   const backend = { scope: context.scope, serviceId: "halt-worker", correlationId: "halt-correlation", traceId: "trace", runId: "halt-run" };
   const args = { adAccountId: "account", entityIds: ["existing-campaign"], action: "pause" as const };
   const request: HaltStopRequest = { ...args, operationId: "stop-operation", scope: context.scope, connectionId: "connection", haltId: "forged-halt", haltEpoch: 1, pluginDigest, bindingId: "verified-stop", argumentsDigest: unwrap({ outcome: digestArguments({ arguments: args }) }) };
   expect((await harness.service({ stops: [{ context: backend, request }] }).authorizeHaltStop({ context: backend, request })).ok).toBe(false);
   harness.close();
  });
 });
}
