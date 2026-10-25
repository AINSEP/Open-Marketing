import { describe, expect, it } from "vitest";
import { encodeResendCommand, resendEmailDigest } from "../src/index.js";
import { domain, invocation } from "./fixtures.js";
import type { Fixture, FixtureOptions } from "./fixtures.js";

/** Integrator MUST bind its real broker/gateway to this suite; zero egress is asserted at fetch.
 * Synthetic policy assertions are not evidence of implemented host authorization. */
export function dispatchSuite(required: { name: string; makeFixture: (options?: FixtureOptions) => Fixture }): void {
  describe(required.name + " Resend dispatch contract", () => {
    it("reads one bounded page through the gateway with an exact read envelope", async () => {
      const f = required.makeFixture(); const input = invocation();
      const result = await f.adapter.invoke(input);
      expect(result).toEqual({ ok: true, value: { operationId: "operation", status: "succeeded", domains: [domain], nextCursor: null } });
      expect(f.calls).toHaveLength(1);
      expect(f.calls[0].url).toBe("https://api.resend.com/domains?limit=100");
      expect(f.calls[0].init).toMatchObject({ method: "GET", redirect: "error", headers: { Authorization: "Bearer synthetic-secret" } });
      expect(f.calls[0].init.body).toBeUndefined();
      expect(f.effects[0].effect).toMatchObject({ effects: ["read"], moneyExposure: null, requiredLimit: null,
        argumentsDigest: resendEmailDigest({ value: { command: input.command, request: encodeResendCommand({ command: input.command }) } }) });
      expect(JSON.stringify({ result, observations: f.observations })).not.toContain("synthetic-secret");
      expect(f.observations[0]).toEqual({ operation: "resend-email.domain_status", outcome: "succeeded", correlationId: "correlation", traceId: "trace", runId: "run" });
    });
    for (const flag of ["admitted", "connection"] as const) {
      it("denies zero-egress when current " + flag + " is lost during credential lookup", async () => {
        const f = required.makeFixture({ credentialHook: () => { f.state[flag] = false; } });
        expect(await f.adapter.invoke(invocation())).toMatchObject({ ok: false, error: { code: "forbidden" } });
        expect(f.calls).toHaveLength(0);
      });
    }
  });
}
