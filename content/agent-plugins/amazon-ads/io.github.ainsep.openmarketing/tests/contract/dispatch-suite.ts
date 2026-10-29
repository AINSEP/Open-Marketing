import { describe, expect, it } from "vitest";
import type { AmazonAdsAdapter } from "../../src/index.js";
import { invocation } from "../fixtures.js";

/** SAME account boundary suite for memory and real transport fixtures; integrator can reuse it. */
export function dispatchSuite(required: { name: string; makeFixture: () => { adapter: AmazonAdsAdapter } }): void {
  describe(required.name, () => {
    it("returns profile identity as a string in a bounded page", async () => {
      const f = required.makeFixture();
      expect(await f.adapter.invoke(invocation())).toMatchObject({ ok: true, value: { status: "succeeded", data: { items: [{ profileId: "123", accountInfo: { name: "Fixture account" } }], nextToken: null } } });
    });

    it("rejects caller auth inflation", async () => {
      const f = required.makeFixture();
      expect(await f.adapter.invoke({ ...invocation(), command: { kind: "list_accounts", accessToken: "injected" } } as never)).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    });
  });
}
