import { describe, it, expect } from "vitest";
import type { PluginRepoPort, PluginLifecyclePort, AgentPluginLayoutPort, AgentPluginMcpProvisioningPort, PluginTrustPort, PluginAuditPort } from "../../src/ports.js";
/** j00 absence contract. Owning job extends this SAME suite with behavioral assertions for double and real adapter. */
export function PluginRepoPortSuite(required: { create: () => PluginRepoPort }) {
describe("PluginRepoPort stub contract", () => {
 it("get fails explicitly", async () => { const port = required.create(); const outcome = await port.get({} as Parameters<PluginRepoPort["get"]>[0]); expect(outcome.ok).toBe(false); if (!outcome.ok) expect(outcome.error.code).toBe("not_implemented"); });
 it("save fails explicitly", async () => { const port = required.create(); const outcome = await port.save({} as Parameters<PluginRepoPort["save"]>[0]); expect(outcome.ok).toBe(false); if (!outcome.ok) expect(outcome.error.code).toBe("not_implemented"); });
}); }
/** j00 absence contract. Owning job extends this SAME suite with behavioral assertions for double and real adapter. */
export function PluginLifecyclePortSuite(required: { create: () => PluginLifecyclePort }) {
describe("PluginLifecyclePort stub contract", () => {
 it("install fails explicitly", async () => { const port = required.create(); const outcome = await port.install({} as Parameters<PluginLifecyclePort["install"]>[0]); expect(outcome.ok).toBe(false); if (!outcome.ok) expect(outcome.error.code).toBe("not_implemented"); });
 it("dispose fails explicitly", async () => { const port = required.create(); const outcome = await port.dispose({} as Parameters<PluginLifecyclePort["dispose"]>[0]); expect(outcome.ok).toBe(false); if (!outcome.ok) expect(outcome.error.code).toBe("not_implemented"); });
}); }
/** j00 absence contract. Owning job extends this SAME suite with behavioral assertions for double and real adapter. */
export function AgentPluginLayoutPortSuite(required: { create: () => AgentPluginLayoutPort }) {
describe("AgentPluginLayoutPort stub contract", () => {
 it("validate fails explicitly", async () => { const port = required.create(); const outcome = await port.validate({} as Parameters<AgentPluginLayoutPort["validate"]>[0]); expect(outcome.ok).toBe(false); if (!outcome.ok) expect(outcome.error.code).toBe("not_implemented"); });
}); }
/** j00 absence contract. Owning job extends this SAME suite with behavioral assertions for double and real adapter. */
export function AgentPluginMcpProvisioningPortSuite(required: { create: () => AgentPluginMcpProvisioningPort }) {
describe("AgentPluginMcpProvisioningPort stub contract", () => {
 it("provision fails explicitly", async () => { const port = required.create(); const outcome = await port.provision({} as Parameters<AgentPluginMcpProvisioningPort["provision"]>[0]); expect(outcome.ok).toBe(false); if (!outcome.ok) expect(outcome.error.code).toBe("not_implemented"); });
 it("dispose fails explicitly", async () => { const port = required.create(); const outcome = await port.dispose({} as Parameters<AgentPluginMcpProvisioningPort["dispose"]>[0]); expect(outcome.ok).toBe(false); if (!outcome.ok) expect(outcome.error.code).toBe("not_implemented"); });
}); }
/** j00 absence contract. Owning job extends this SAME suite with behavioral assertions for double and real adapter. */
export function PluginTrustPortSuite(required: { create: () => PluginTrustPort }) {
describe("PluginTrustPort stub contract", () => {
 it("verify fails explicitly", async () => { const port = required.create(); const outcome = await port.verify({} as Parameters<PluginTrustPort["verify"]>[0]); expect(outcome.ok).toBe(false); if (!outcome.ok) expect(outcome.error.code).toBe("not_implemented"); });
}); }
/** j00 absence contract. Owning job extends this SAME suite with behavioral assertions for double and real adapter. */
export function PluginAuditPortSuite(required: { create: () => PluginAuditPort }) {
describe("PluginAuditPort stub contract", () => {
 it("record fails explicitly", async () => { const port = required.create(); const outcome = await port.record({} as Parameters<PluginAuditPort["record"]>[0]); expect(outcome.ok).toBe(false); if (!outcome.ok) expect(outcome.error.code).toBe("not_implemented"); });
}); }
