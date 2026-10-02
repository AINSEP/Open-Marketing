import { describe, it, expect } from "vitest";
import type { WorkspaceRepoPort, IdentityPort, AccountBindingLookupPort } from "../../src/ports.js";
/** j00 absence contract. Owning job extends this SAME suite with behavioral assertions for double and real adapter. */
export function WorkspaceRepoPortSuite(required: { create: () => WorkspaceRepoPort }) {
describe("WorkspaceRepoPort stub contract", () => {
 it("resolve fails explicitly", async () => { const port = required.create(); const outcome = await port.resolve({} as Parameters<WorkspaceRepoPort["resolve"]>[0]); expect(outcome.ok).toBe(false); if (!outcome.ok) expect(outcome.error.code).toBe("not_implemented"); });
 it("bind fails explicitly", async () => { const port = required.create(); const outcome = await port.bind({} as Parameters<WorkspaceRepoPort["bind"]>[0]); expect(outcome.ok).toBe(false); if (!outcome.ok) expect(outcome.error.code).toBe("not_implemented"); });
}); }
/** j00 absence contract. Owning job extends this SAME suite with behavioral assertions for double and real adapter. */
export function IdentityPortSuite(required: { create: () => IdentityPort }) {
describe("IdentityPort stub contract", () => {
 it("verify fails explicitly", async () => { const port = required.create(); const outcome = await port.verify({} as Parameters<IdentityPort["verify"]>[0]); expect(outcome.ok).toBe(false); if (!outcome.ok) expect(outcome.error.code).toBe("not_implemented"); });
}); }
/** j00 absence contract. Owning job extends this SAME suite with behavioral assertions for double and real adapter. */
export function AccountBindingLookupPortSuite(required: { create: () => AccountBindingLookupPort }) {
describe("AccountBindingLookupPort stub contract", () => {
 it("find fails explicitly", async () => { const port = required.create(); const outcome = await port.find({} as Parameters<AccountBindingLookupPort["find"]>[0]); expect(outcome.ok).toBe(false); if (!outcome.ok) expect(outcome.error.code).toBe("not_implemented"); });
}); }
