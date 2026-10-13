import { describe, it, expect } from "vitest";
import type { CreativeRepoPort, GenerationCapabilityPort, GenerationStatus } from "../../index.js";
import { context, generationRequest, intentFor, value } from "../support/fixtures.js";

/** Identical behavioral fixture for memory capability and released Jini runtime adapter. */
export type CapabilityFixture = { port: GenerationCapabilityPort; repo: CreativeRepoPort; status: GenerationStatus; finish: () => Promise<void> };
/** Intent binding, bounded workers and local cancellation are independent of the runtime adapter. */
export function GenerationCapabilityPortSuite(required: { create: () => Promise<CapabilityFixture> }) {
  describe("GenerationCapabilityPort behavior", () => {
    it("quotes original arguments and generates a recoverable operation", async () => {
      const fixture = await required.create();
      const quote = value({ outcome: await fixture.port.quote({ context, request: fixture.status.request }) });
      expect(quote.argumentsDigest).toBe(fixture.status.request.argumentsDigest);
      const receipt = value({ outcome: await fixture.port.generate({ context, request: fixture.status.request, quote, generationId: fixture.status.generationId }) });
      expect(receipt.generationId).toBe(fixture.status.generationId);
      expect(receipt.asyncOperationId).toEqual(expect.any(String));
      await fixture.finish();
      const status = value({ outcome: await fixture.port.status({ context, generationId: fixture.status.generationId }) });
      expect(status.state).toBe("succeeded");
      expect(status.asyncOperationId).toBe(receipt.asyncOperationId);
      expect(status.request).toEqual(fixture.status.request);
      expect(status.quote).toEqual(quote);
      expect(status.operation?.result?.bytesBase64).toBe("aW1hZ2U=");
      expect(await fixture.port.generate({ context, request: fixture.status.request, quote, generationId: fixture.status.generationId })).toMatchObject({ ok: false, error: { code: "conflict" } });
    });
    it("rejects argument drift and dispatch without a reservation", async () => {
      const fixture = await required.create();
      expect(await fixture.port.generate({ context, request: generationRequest({ prompt: "changed" }), quote: fixture.status.quote, generationId: fixture.status.generationId })).toMatchObject({ ok: false, error: { code: "conflict" } });
      const request = generationRequest({ operationId: "unreserved" });
      const intent = intentFor({ request });
      value({ outcome: await fixture.repo.save({ context, status: intent }) });
      expect(await fixture.port.generate({ context, request, quote: intent.quote, generationId: intent.generationId })).toMatchObject({ ok: false, error: { code: "forbidden" } });
    });
    it("bounds polling and recovers without an agent", async () => {
      const fixture = await required.create();
      expect(await fixture.port.pollDue({ context, request: { leaseOwner: "worker", leaseMs: 1000, limit: 101 } })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
      expect(await fixture.port.pollDue({ context, request: { leaseOwner: "worker", leaseMs: 1000, limit: 1 } })).toMatchObject({ ok: true, value: { claimed: 0 } });
      expect(await fixture.port.recover({ context })).toMatchObject({ ok: true, value: { resubmittable: [] } });
    });
    it("cancels locally without releasing exposure or submitting again", async () => {
      const fixture = await required.create();
      const cancelled = value({ outcome: await fixture.port.cancel({ context, generationId: fixture.status.generationId }) });
      expect(cancelled.state).toBe("cancelled");
      expect(cancelled.reservationId).toBe("reservation");
      const current = value({ outcome: await fixture.repo.get({ context, generationId: fixture.status.generationId }) });
      // The service owns the durable marker; some capability adapters also persist it.
      value({ outcome: await fixture.repo.save({ context, status: { ...current, state: "cancelled" } }) });
      expect(await fixture.port.generate({ context, request: cancelled.request, quote: cancelled.quote, generationId: cancelled.generationId })).toMatchObject({ ok: false, error: { code: "cancelled" } });
    });
  });
}
