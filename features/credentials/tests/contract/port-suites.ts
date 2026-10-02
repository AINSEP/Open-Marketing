import { describe, it, expect } from "vitest";
import type { CredentialRepoPort, SecretSealerPort, KeyringPort, OAuthClientPort, CredentialLockPort, CredentialAuditPort, CredentialBrokerPort } from "../../src/ports.js";
/** j00 absence contract. Owning job extends this SAME suite with behavioral assertions for double and real adapter. */
export function CredentialRepoPortSuite(required: { create: () => CredentialRepoPort }) {
describe("CredentialRepoPort stub contract", () => {
 it("get fails explicitly", async () => { const port = required.create(); const outcome = await port.get({} as Parameters<CredentialRepoPort["get"]>[0]); expect(outcome.ok).toBe(false); if (!outcome.ok) expect(outcome.error.code).toBe("not_implemented"); });
 it("store fails explicitly", async () => { const port = required.create(); const outcome = await port.store({} as Parameters<CredentialRepoPort["store"]>[0]); expect(outcome.ok).toBe(false); if (!outcome.ok) expect(outcome.error.code).toBe("not_implemented"); });
 it("revoke fails explicitly", async () => { const port = required.create(); const outcome = await port.revoke({} as Parameters<CredentialRepoPort["revoke"]>[0]); expect(outcome.ok).toBe(false); if (!outcome.ok) expect(outcome.error.code).toBe("not_implemented"); });
}); }
/** j00 absence contract. Owning job extends this SAME suite with behavioral assertions for double and real adapter. */
export function SecretSealerPortSuite(required: { create: () => SecretSealerPort }) {
describe("SecretSealerPort stub contract", () => {
 it("seal fails explicitly", async () => { const port = required.create(); const outcome = await port.seal({} as Parameters<SecretSealerPort["seal"]>[0]); expect(outcome.ok).toBe(false); if (!outcome.ok) expect(outcome.error.code).toBe("not_implemented"); });
 it("open fails explicitly", async () => { const port = required.create(); const outcome = await port.open({} as Parameters<SecretSealerPort["open"]>[0]); expect(outcome.ok).toBe(false); if (!outcome.ok) expect(outcome.error.code).toBe("not_implemented"); });
}); }
/** j00 absence contract. Owning job extends this SAME suite with behavioral assertions for double and real adapter. */
export function KeyringPortSuite(required: { create: () => KeyringPort }) {
describe("KeyringPort stub contract", () => {
 it("resolve fails explicitly", async () => { const port = required.create(); const outcome = await port.resolve({} as Parameters<KeyringPort["resolve"]>[0]); expect(outcome.ok).toBe(false); if (!outcome.ok) expect(outcome.error.code).toBe("not_implemented"); });
}); }
/** j00 absence contract. Owning job extends this SAME suite with behavioral assertions for double and real adapter. */
export function OAuthClientPortSuite(required: { create: () => OAuthClientPort }) {
describe("OAuthClientPort stub contract", () => {
 it("begin fails explicitly", async () => { const port = required.create(); const outcome = await port.begin({} as Parameters<OAuthClientPort["begin"]>[0]); expect(outcome.ok).toBe(false); if (!outcome.ok) expect(outcome.error.code).toBe("not_implemented"); });
 it("complete fails explicitly", async () => { const port = required.create(); const outcome = await port.complete({} as Parameters<OAuthClientPort["complete"]>[0]); expect(outcome.ok).toBe(false); if (!outcome.ok) expect(outcome.error.code).toBe("not_implemented"); });
}); }
/** j00 absence contract. Owning job extends this SAME suite with behavioral assertions for double and real adapter. */
export function CredentialLockPortSuite(required: { create: () => CredentialLockPort }) {
describe("CredentialLockPort stub contract", () => {
 it("acquire fails explicitly", async () => { const port = required.create(); const outcome = await port.acquire({} as Parameters<CredentialLockPort["acquire"]>[0]); expect(outcome.ok).toBe(false); if (!outcome.ok) expect(outcome.error.code).toBe("not_implemented"); });
 it("release fails explicitly", async () => { const port = required.create(); const outcome = await port.release({} as Parameters<CredentialLockPort["release"]>[0]); expect(outcome.ok).toBe(false); if (!outcome.ok) expect(outcome.error.code).toBe("not_implemented"); });
}); }
/** j00 absence contract. Owning job extends this SAME suite with behavioral assertions for double and real adapter. */
export function CredentialAuditPortSuite(required: { create: () => CredentialAuditPort }) {
describe("CredentialAuditPort stub contract", () => {
 it("record fails explicitly", async () => { const port = required.create(); const outcome = await port.record({} as Parameters<CredentialAuditPort["record"]>[0]); expect(outcome.ok).toBe(false); if (!outcome.ok) expect(outcome.error.code).toBe("not_implemented"); });
}); }
/** j00 absence contract. Owning job extends this SAME suite with behavioral assertions for double and real adapter. */
export function CredentialBrokerPortSuite(required: { create: () => CredentialBrokerPort }) {
describe("CredentialBrokerPort stub contract", () => {
 it("use fails explicitly", async () => { const port = required.create(); const outcome = await port.use({} as Parameters<CredentialBrokerPort["use"]>[0]); expect(outcome.ok).toBe(false); if (!outcome.ok) expect(outcome.error.code).toBe("not_implemented"); });
}); }
