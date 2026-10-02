import { describe, it, expect } from "vitest";
import type { AuditRepoPort, AuditRedactorPort } from "../../src/ports.js";
/** j00 absence contract. Owning job extends this SAME suite with behavioral assertions for double and real adapter. */
export function AuditRepoPortSuite(required: { create: () => AuditRepoPort }) {
describe("AuditRepoPort stub contract", () => {
 it("append fails explicitly", async () => { const port = required.create(); const outcome = await port.append({} as Parameters<AuditRepoPort["append"]>[0]); expect(outcome.ok).toBe(false); if (!outcome.ok) expect(outcome.error.code).toBe("not_implemented"); });
 it("list fails explicitly", async () => { const port = required.create(); const outcome = await port.list({} as Parameters<AuditRepoPort["list"]>[0]); expect(outcome.ok).toBe(false); if (!outcome.ok) expect(outcome.error.code).toBe("not_implemented"); });
}); }
/** j00 absence contract. Owning job extends this SAME suite with behavioral assertions for double and real adapter. */
export function AuditRedactorPortSuite(required: { create: () => AuditRedactorPort }) {
describe("AuditRedactorPort stub contract", () => {
 it("redact fails explicitly", async () => { const port = required.create(); const outcome = await port.redact({} as Parameters<AuditRedactorPort["redact"]>[0]); expect(outcome.ok).toBe(false); if (!outcome.ok) expect(outcome.error.code).toBe("not_implemented"); });
}); }
