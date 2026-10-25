import { describe, expect, it } from "vitest";
import type { AmazonSesAdapter } from "../src/index.js";
import { invocation } from "./fixtures.js";

/** One suite for memory and real broker/gateway harnesses. No live AWS access allowed. */
export function sesHostContractSuite(required: { name: string; createHarness: () => {
  adapter: AmazonSesAdapter; calls: readonly unknown[]; denyAdmission: () => void; denyCredentials: () => void;
} }): void {
  describe(required.name, () => {
    it("is inert until invoked and executes an admitted read", async () => {
      const f = required.createHarness(); expect(f.calls).toHaveLength(0);
      expect((await f.adapter.invoke(invocation)).ok).toBe(true); expect(f.calls).toHaveLength(1);
    });
    it("rechecks admission on every invocation", async () => {
      const f = required.createHarness(); await f.adapter.invoke(invocation); f.denyAdmission();
      expect((await f.adapter.invoke(invocation)).ok).toBe(false); expect(f.calls).toHaveLength(1);
    });
    it("denies broker failures before egress", async () => {
      const f = required.createHarness(); f.denyCredentials();
      expect((await f.adapter.invoke(invocation)).ok).toBe(false); expect(f.calls).toHaveLength(0);
    });
  });
}
