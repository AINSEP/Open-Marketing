import { describe, expect, it } from "vitest";
import { invocation } from "../fixtures.js";
import type { fixture } from "../fixtures.js";

/** Integrator must bind the real broker/policy adapters to this same suite before activation. */
export function dispatchSuite(required: { name: string; makeFixture: () => ReturnType<typeof fixture> }): void {
  describe(required.name + " WhatsApp dispatch contract", () => {
    it("projects the bound account through one authenticated GET", async () => {
      const f = required.makeFixture();
      expect(await f.adapter.invoke(invocation())).toEqual({ ok: true, value: { operationId: "operation", data: { id: "123", name: "Fixture", business_verification_status: "VERIFIED", account_review_status: "APPROVED" } } });
      expect(f.calls).toHaveLength(1);
      expect(f.calls[0].url).toBe("https://graph.facebook.com/v26.0/123?fields=id,name,business_verification_status,account_review_status");
      expect(f.calls[0].init).toMatchObject({ method: "GET", redirect: "error", headers: { Authorization: "Bearer synthetic-secret" } });
      expect(f.credentials).toMatchObject([{ configuration: { connectionId: "meta-connection", wabaId: "123", phoneNumberId: "456" }, context: { scope: { ownerId: "owner", workspaceId: "workspace" } } }]);
      expect(f.observations).toEqual([{ operation: "whatsapp-business.get_account_status", outcome: "succeeded", correlationId: "correlation", traceId: "trace", runId: "run" }]);
    });
    it("host denial prevents credential lookup, refresh and network", async () => {
      const f = required.makeFixture(); f.state.admitted = false;
      expect(await f.adapter.invoke(invocation())).toMatchObject({ ok: false, error: { code: "forbidden" } });
      expect(f.credentials).toHaveLength(0); expect(f.calls).toHaveLength(0);
    });
    it("rejects foreign owner/workspace and cancellation before I/O", async () => {
      const f = required.makeFixture();
      for (const scope of [{ ownerId: "foreign", workspaceId: "workspace" }, { ownerId: "owner", workspaceId: "foreign" }]) {
        expect(await f.adapter.invoke({ ...invocation(), context: { ...invocation().context, scope } })).toMatchObject({ ok: false, error: { code: "forbidden" } });
      }
      expect(await f.adapter.invoke(invocation(), { signal: AbortSignal.abort() })).toMatchObject({ ok: false, error: { code: "cancelled" } });
      expect(f.credentials).toHaveLength(0); expect(f.calls).toHaveLength(0);
    });
  });
}
