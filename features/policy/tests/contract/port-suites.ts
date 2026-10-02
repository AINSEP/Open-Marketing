import { describe, it, expect } from "vitest";
import type { PolicyRepoPort, CanonicalIdentityPort } from "../../src/ports.js";
/** j00 absence contract. Owning job extends this SAME suite with behavioral assertions for double and real adapter. */
export function PolicyRepoPortSuite(required: { create: () => PolicyRepoPort }) {
describe("PolicyRepoPort stub contract", () => {
 it("snapshot fails explicitly", async () => { const port = required.create(); const outcome = await port.snapshot({} as Parameters<PolicyRepoPort["snapshot"]>[0]); expect(outcome.ok).toBe(false); if (!outcome.ok) expect(outcome.error.code).toBe("not_implemented"); });
 it("appendEvidence fails explicitly", async () => { const port = required.create(); const outcome = await port.appendEvidence({} as Parameters<PolicyRepoPort["appendEvidence"]>[0]); expect(outcome.ok).toBe(false); if (!outcome.ok) expect(outcome.error.code).toBe("not_implemented"); });
}); }
/** j00 absence contract. Owning job extends this SAME suite with behavioral assertions for double and real adapter. */
export function CanonicalIdentityPortSuite(required: { create: () => CanonicalIdentityPort }) {
describe("CanonicalIdentityPort stub contract", () => {
 it("resolve fails explicitly", async () => { const port = required.create(); const outcome = await port.resolve({} as Parameters<CanonicalIdentityPort["resolve"]>[0]); expect(outcome.ok).toBe(false); if (!outcome.ok) expect(outcome.error.code).toBe("not_implemented"); });
}); }
