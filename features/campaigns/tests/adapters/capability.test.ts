import { describe, it, expect } from "vitest";
import type { CampaignBackendPort } from "../../index.js";
import { createCampaignCapabilityAdapter, createMemoryCampaignCapability } from "../../index.js";
import { CampaignCapabilityPortSuite } from "../contract/port-suites.js";
import { context, draft, proposal, request, value } from "../fixtures.js";

/** Local backend fixture delegates to a strict scoped provider, exercising adapter validation. */
function createBackend(): CampaignBackendPort {
  const provider = createMemoryCampaignCapability({});
  return {
    async invoke(input, options) {
      switch (input.operation) {
        case "create-paused": return provider.createPaused(input.payload as Parameters<typeof provider.createPaused>[0], options);
        case "launch": return provider.launch(input.payload as Parameters<typeof provider.launch>[0], options);
        case "read-state": return provider.readState(input.payload as Parameters<typeof provider.readState>[0], options);
        default: { const exhaustive: never = input.operation; throw new Error(String(exhaustive)); }
      }
    },
  };
}
CampaignCapabilityPortSuite({ create: () => createCampaignCapabilityAdapter({ backend: createBackend() }) });

describe("capability validation/transport contract", () => {
  it("rejects active create acknowledgements and oversized/malformed readbacks", async () => {
    const adapter = createCampaignCapabilityAdapter({ backend: { async invoke(input) {
      if (input.operation === "create-paused") return { ok: true, value: { campaignId: "campaign", desiredState: "active", observedState: "active" } };
      return { ok: true, value: { state: { campaignId: "campaign", state: "paused", observedAt: 900, providerReference: "provider" }, hierarchy: Array.from({ length: 501 }, (_entry, index) => ({ entityId: "entity-" + index, state: "paused" })), complete: true, operationId: "create-1" } };
    } } });
    expect(await adapter.createPaused({ context, draft, campaignId: "campaign", permitId: "permit" })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect(await adapter.readState({ context, campaignId: "campaign", connectionId: "connection", accountId: "account", operationId: "create-1" })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
  });
  it("propagates exact payload, operation identity, timeout, signal and trace", async () => {
    const captures: Parameters<CampaignBackendPort["invoke"]>[0][] = [];
    const signals: (AbortSignal | undefined)[] = [];
    const adapter = createCampaignCapabilityAdapter({ backend: { async invoke(input, options) { captures.push(input); signals.push(options?.signal); return { ok: true, value: { operationId: "launch-1", status: "unknown" } }; } } }, { timeoutMs: 3210 });
    const exact = proposal({ campaignId: "campaign" });
    const input = { context, request: request({ proposal: exact }), proposal: exact, permitId: "permit" };
    const controller = new AbortController();
    expect(value({ outcome: await adapter.launch(input, { signal: controller.signal }) }).status).toBe("unknown");
    expect(captures).toEqual([{ context, operation: "launch", operationId: "launch-1", payload: input, timeoutMs: 3210 }]);
    expect(signals).toEqual([controller.signal]);
  });
  it("maps thrown/time-out transport failures, cancellation and invalid timeout without retries", async () => {
    let calls = 0;
    const backend: CampaignBackendPort = { async invoke() { calls += 1; throw new Error("secret transport failure"); } };
    const adapter = createCampaignCapabilityAdapter({ backend });
    const input = { context, draft, campaignId: "campaign", permitId: "permit" };
    expect(await adapter.createPaused(input)).toEqual({ ok: false, error: { code: "unavailable", message: "Campaign capability unavailable", retryable: false } });
    const controller = new AbortController();
    controller.abort();
    expect(await adapter.createPaused(input, { signal: controller.signal })).toMatchObject({ ok: false, error: { code: "cancelled" } });
    expect(await createCampaignCapabilityAdapter({ backend }, { timeoutMs: 0 }).createPaused(input)).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect(calls).toBe(1);
  });
});
