import { describe, expect, it } from "vitest";
import { digest, failure } from "../../src/boundary.js";
import { createMetaAdsAdapter, createHostedMetaGateway } from "../../src/adapter.js";
import { createUnavailableMetaEvidence } from "../../src/evidence.js";
import { decodeMetaHierarchy } from "../../src/readback.js";
import type { MetaBinding } from "../../src/evidence.js";
import { binding, campaign, clock, fixture, hierarchy, now, observer, pluginDigest, request, schemas } from "../fixtures.js";

/** Shared applicable contract: evidence, exact payload, cancellation, uncertainty and redacted observations. */
export function gatewaySuite(required: { kind: "double" | "hosted" }): void {
  describe(required.kind + " Meta gateway contract", () => {
    it("creates PAUSED without spending fields or automatic activation; an ACK cannot prove PAUSED", async () => {
      const f = fixture(required);
      const result = await f.adapter.invoke({ ...request(), moneyExposure: null, requiredLimit: null });
      expect(result).toEqual({ ok: true, value: { operationId: "operation", status: "succeeded", data: { id: "456" }, observedState: "unknown" } });
      expect(f.calls).toHaveLength(1);
      expect(f.calls[0].arguments).toEqual({ ad_account_id: "123", name: "fixture", objective: "OUTCOME_TRAFFIC", special_ad_categories: [], status: "PAUSED" });
      expect(f.calls[0].argumentsDigest).toBe(digest({ value: f.calls[0].arguments }));
      expect(f.observations).toEqual([{ operation: "meta-ads.create-campaign", outcome: "succeeded", correlationId: "correlation", traceId: "trace", runId: "run" }]);
    });
    it("requires separate activation evidence and current exact host authority after creation", async () => {
      const f = fixture(required);
      expect((await f.adapter.invoke(request())).ok).toBe(true);
      const activation = request({ command: { kind: "activate", entityId: "456", entityType: "campaign" }, operationId: "activation-1" });
      expect(await f.adapter.invoke(activation)).toMatchObject({ ok: false, error: { code: "forbidden" } });
      expect(f.calls).toHaveLength(1);
      f.evidence.value = binding({ invocation: activation });
      expect(await f.adapter.invoke(activation)).toMatchObject({ ok: true, value: { operationId: "activation-1", status: "succeeded" } });
      expect(f.calls.map(call => [call.operationId, call.arguments.status])).toEqual([["operation", "PAUSED"], ["activation-1", "ACTIVE"]]);
      const denied = fixture({ ...required, invocation: activation, handler: async () => failure({ code: "forbidden", message: "Exact activation card missing or revoked" }) });
      expect(await denied.adapter.invoke(activation)).toMatchObject({ ok: false, error: { code: "forbidden" } });
      expect(denied.calls).toHaveLength(1);
    });
    it("does not promote a creation ACK or incomplete hierarchy readback to observed PAUSED", async () => {
      const f = fixture(required);
      expect(await f.adapter.invoke(request())).toMatchObject({ ok: true, value: { observedState: "unknown" } });
      const incomplete = decodeMetaHierarchy({ input: { ...hierarchy, entities: hierarchy.entities.slice(0, 1) }, accountId: "123", expectedEntityIds: ["456", "457", "458"], observedAt: now });
      expect(incomplete).toMatchObject({ ok: true, value: { complete: false, state: "unknown" } });
      expect(f.calls).toHaveLength(1);
    });
    it.each(["create", "activation"])("returns unavailable for unverified %s behavior before gateway handoff", async operation => {
      const invocation = operation === "create" ? request() : request({ command: { kind: "activate", entityId: "456", entityType: "campaign" }, operationId: "activation-1" });
      const f = fixture({ ...required, invocation });
      f.evidence.value = { ...(f.evidence.value as MetaBinding), claims: [] };
      expect(await f.adapter.invoke(invocation)).toMatchObject({ ok: false, error: { code: "unavailable" } });
      expect(f.calls).toHaveLength(0);
    });
    it("maps activation to exactly one reviewed entity and forwards a fresh operation identity", async () => {
      const invocation = request({ command: { kind: "activate", entityId: "456", entityType: "campaign" }, operationId: "activation-1" });
      const f = fixture({ ...required, invocation });
      const result = await f.adapter.invoke(invocation);
      expect(result.ok).toBe(true);
      expect(f.calls[0]).toMatchObject({ operationId: "activation-1", toolName: "meta-ads.ads_activate_entity", arguments: { ad_account_id: "123", entity_id: "456", entity_type: "campaign", status: "ACTIVE" } });
      expect(f.calls).toHaveLength(1);
    });
    it.each(["scope", "accountId", "connectionId", "pluginDigest", "operation", "claims", "expiresAt", "schemaFingerprint", "status"])("denies mutated %s evidence before egress", async field => {
      const f = fixture(required);
      const value = { ...(f.evidence.value as MetaBinding) } as Record<string, unknown>;
      const wrong: Record<string, unknown> = { scope: { ownerId: "foreign", workspaceId: "workspace" }, accountId: "999", connectionId: "foreign", pluginDigest: "c".repeat(64), operation: "activate", claims: [], expiresAt: 1, schemaFingerprint: "c".repeat(64), status: "proposed" };
      value[field] = wrong[field]; f.evidence.value = value;
      const result = await f.adapter.invoke(request());
      expect(result.ok).toBe(false);
      expect(f.calls).toHaveLength(0);
    });
    it("rejects an input-schema failure before gateway handoff", async () => {
      const f = fixture({ ...required, schemas: { validate: () => failure({ code: "protocol_mismatch", message: "Changed actual schema" }) } });
      const result = await f.adapter.invoke(request());
      expect(result).toMatchObject({ ok: false, error: { code: "protocol_mismatch" } });
      expect(f.calls).toHaveLength(0);
    });
    it("rejects ACTIVE inflation of a creation command", async () => {
      const f = fixture(required);
      const input = { ...request(), command: { ...campaign, status: "ACTIVE" } };
      const result = await f.adapter.invoke(input as ReturnType<typeof request>);
      expect(result.ok).toBe(false);
      expect(f.calls).toHaveLength(0);
    });
    it("denies money operations with no exposure or limit evidence", async () => {
      const invocation = request({ command: { kind: "activate", entityId: "456", entityType: "campaign" } });
      const f = fixture({ ...required, invocation });
      const result = await f.adapter.invoke({ ...invocation, requiredLimit: null });
      expect(result).toMatchObject({ ok: false, error: { code: "forbidden" } });
      expect(f.calls).toHaveLength(0);
    });
    it("never blindly retries a timeout with an unknown non-idempotent outcome", async () => {
      const f = fixture({ ...required, handler: async () => { throw new Error("fixture timeout containing secret"); } });
      const result = await f.adapter.invoke(request());
      expect(result).toMatchObject({ ok: true, value: { status: "unknown", observedState: "unknown", data: null } });
      expect(f.calls).toHaveLength(1);
      expect(JSON.stringify(f.observations)).not.toContain("secret");
    });
    it("treats a typed transport failure after handoff as unknown, with one call", async () => {
      const f = fixture({ ...required, handler: async () => failure({ code: "unavailable", message: "Timeout after egress" }) });
      expect(await f.adapter.invoke(request())).toMatchObject({ ok: true, value: { status: "unknown" } });
      expect(f.calls).toHaveLength(1);
    });
    it.each([
      { operationId: "wrong", status: "succeeded", content: [{ type: "json", data: { id: "456" } }] },
      { operationId: "operation", status: "succeeded", content: [{ type: "json", data: { id: "bad-id", credential: "secret" } }] },
      { operationId: "operation", status: "succeeded", content: [{ type: "text", text: "not-json" }] },
      { operationId: "operation", status: "succeeded", content: [{ type: "json", data: { id: "456" } }, { type: "json", data: { id: "457" } }] },
      { operationId: "operation", status: "succeeded", content: [{ type: "text", text: "x".repeat(140000) }] },
    ])("keeps invalid or ambiguous acknowledgement unknown", async raw => {
      const f = fixture({ ...required, handler: async () => ({ ok: true, value: raw }) });
      expect(await f.adapter.invoke(request())).toMatchObject({ ok: true, value: { status: "unknown" } });
      expect(f.calls).toHaveLength(1);
    });
    it("accepts one validated JSON text response", async () => {
      const f = fixture({ ...required, handler: async () => ({ ok: true, value: { operationId: "operation", status: "succeeded", content: [{ type: "text", text: '{"id":"456"}' }] } }) });
      expect(await f.adapter.invoke(request())).toMatchObject({ ok: true, value: { data: { id: "456" }, observedState: "unknown" } });
    });
    it("preserves a current host revocation denial without treating it as success", async () => {
      const f = fixture({ ...required, handler: async () => failure({ code: "forbidden", message: "Host revoked the exact operation" }) });
      expect(await f.adapter.invoke(request())).toMatchObject({ ok: false, error: { code: "forbidden", retryable: false } });
      expect(f.calls).toHaveLength(1);
    });
    it("cancels before egress and forwards caller cancellation", async () => {
      const f = fixture(required);
      const controller = new AbortController(); controller.abort();
      expect(await f.adapter.invoke(request(), { signal: controller.signal })).toMatchObject({ ok: false, error: { code: "cancelled" } });
      expect(f.calls).toHaveLength(0);
    });
    it("telemetry failure cannot change a known vendor outcome", async () => {
      const f = fixture({ ...required, observer: { observe() { throw new Error("telemetry down"); } } });
      expect(await f.adapter.invoke(request())).toMatchObject({ ok: true, value: { status: "succeeded" } });
    });
  });
}

describe("unavailable default and configuration", () => {
  it("has no admitted capability merely because the plugin is enabled", async () => {
    let calls = 0;
    const adapter = createMetaAdsAdapter({ evidence: createUnavailableMetaEvidence({}), gateway: { invoke: async () => { calls += 1; return failure({ code: "unavailable", message: "Must not dispatch" }); } }, schemas, clock, observer, pluginDigest });
    expect(await adapter.invoke(request())).toMatchObject({ ok: false, error: { code: "unavailable" } });
    expect(calls).toBe(0);
  });
  it("requires the same bounded timeout as the hosted federation", async () => {
    const gateway = createHostedMetaGateway({ host: { invoke: async () => { throw new Error("Must not dispatch"); } }, timeoutMs: 10000 });
    const invocation = request();
    const call = { operationId: invocation.operationId, connectionId: invocation.connectionId, toolName: "meta-ads.ads_create_campaign", arguments: {}, argumentsDigest: pluginDigest, pluginDigest, schemaFingerprint: pluginDigest };
    const effect = { operationId: invocation.operationId, connectionId: invocation.connectionId, accountId: invocation.accountId, effects: ["write" as const], argumentsDigest: pluginDigest, moneyExposure: null, requiredLimit: null };
    expect(await gateway.invoke({ context: invocation.context, call, effect, timeoutMs: 15000 })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
  });
});
