import { describe, expect, it } from "vitest";
import { invocation } from "../fixtures.js";
import type { fixture } from "../fixtures.js";

/** Integrator must run this same suite with the server's bound credential/guarded-fetch adapter. */
export function dispatchSuite(required: { name: string; makeFixture: () => ReturnType<typeof fixture> }): void {
  describe(required.name + " Naver dispatch contract", () => {
    it("keeps factories inert and unadmitted calls free of credential/network I/O", async () => {
      const f = required.makeFixture();
      expect(f.calls).toHaveLength(0); expect(f.credentialCalls).toHaveLength(0);
      f.configuration.admitted = false;
      expect(await f.adapter.invoke(invocation())).toMatchObject({ ok: false, error: { code: "forbidden" } });
      expect(f.calls).toHaveLength(0); expect(f.credentialCalls).toHaveLength(0);
    });
    it("rejects foreign scope and inflated command fields before credentials", async () => {
      const f = required.makeFixture();
      expect(await f.adapter.invoke({ ...invocation(), context: { ...invocation().context, scope: { ownerId: "other", workspaceId: "workspace" } } })).toMatchObject({ ok: false, error: { code: "forbidden" } });
      expect(await f.adapter.invoke({ ...invocation(), command: { kind: "list_campaigns", accountId: "other" } } as unknown as ReturnType<typeof invocation>)).toMatchObject({ ok: false, error: { code: "invalid_input" } });
      expect(f.calls).toHaveLength(0); expect(f.credentialCalls).toHaveLength(0);
    });
    it("uses the selected customer and propagates trace identity without exposing credentials", async () => {
      const f = required.makeFixture();
      const result = await f.adapter.invoke(invocation());
      expect(result).toMatchObject({ ok: true, value: { operationId: "operation", status: "succeeded", data: { items: [{ customerId: "222" }] } } });
      expect(f.credentialCalls).toEqual([{ connectionId: "connection", accountId: "222" }]);
      expect(new Headers(f.calls[0]!.init.headers).get("X-Customer")).toBe("222");
      expect(f.observations).toEqual([{ operation: "naver-ads.list_campaigns", outcome: "succeeded", correlationId: "correlation", traceId: "trace", runId: "run" }]);
      expect(JSON.stringify({ result, observations: f.observations })).not.toMatch(/fixture-secret|fixture-license/);
    });
    it("honors caller cancellation before any I/O", async () => {
      const f = required.makeFixture();
      expect(await f.adapter.invoke(invocation(), { signal: AbortSignal.abort() })).toMatchObject({ ok: false, error: { code: "cancelled" } });
      expect(f.calls).toHaveLength(0); expect(f.credentialCalls).toHaveLength(0);
    });
  });
}
