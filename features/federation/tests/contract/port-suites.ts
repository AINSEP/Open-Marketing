import { describe, it, expect } from "vitest";
import type { FederationConnectionRepoPort, McpTransportPort, FederationCredentialPort, FederatedToolPermissionGate, FederatedCallConfirmation, ExternalMcpToolApprovalRepoPort, FederatedDispatchGatePort, FederationAuditPort, ToolRegistryPort } from "../../src/ports.js";
/** j00 absence contract. Owning job extends this SAME suite with behavioral assertions for double and real adapter. */
export function FederationConnectionRepoPortSuite(required: { create: () => FederationConnectionRepoPort }) {
describe("FederationConnectionRepoPort stub contract", () => {
 it("get fails explicitly", async () => { const port = required.create(); const outcome = await port.get({} as Parameters<FederationConnectionRepoPort["get"]>[0]); expect(outcome.ok).toBe(false); if (!outcome.ok) expect(outcome.error.code).toBe("not_implemented"); });
}); }
/** j00 absence contract. Owning job extends this SAME suite with behavioral assertions for double and real adapter. */
export function McpTransportPortSuite(required: { create: () => McpTransportPort }) {
describe("McpTransportPort stub contract", () => {
 it("invoke fails explicitly", async () => { const port = required.create(); const outcome = await port.invoke({} as Parameters<McpTransportPort["invoke"]>[0]); expect(outcome.ok).toBe(false); if (!outcome.ok) expect(outcome.error.code).toBe("not_implemented"); });
 it("dispose fails explicitly", async () => { const port = required.create(); const outcome = await port.dispose({} as Parameters<McpTransportPort["dispose"]>[0]); expect(outcome.ok).toBe(false); if (!outcome.ok) expect(outcome.error.code).toBe("not_implemented"); });
}); }
/** j00 absence contract. Owning job extends this SAME suite with behavioral assertions for double and real adapter. */
export function FederationCredentialPortSuite(required: { create: () => FederationCredentialPort }) {
describe("FederationCredentialPort stub contract", () => {
 it("authorizeUse fails explicitly", async () => { const port = required.create(); const outcome = await port.authorizeUse({} as Parameters<FederationCredentialPort["authorizeUse"]>[0]); expect(outcome.ok).toBe(false); if (!outcome.ok) expect(outcome.error.code).toBe("not_implemented"); });
}); }
/** j00 absence contract. Owning job extends this SAME suite with behavioral assertions for double and real adapter. */
export function FederatedToolPermissionGateSuite(required: { create: () => FederatedToolPermissionGate }) {
describe("FederatedToolPermissionGate stub contract", () => {
 it("assess fails explicitly", async () => { const port = required.create(); const outcome = await port.assess({} as Parameters<FederatedToolPermissionGate["assess"]>[0]); expect(outcome.ok).toBe(false); if (!outcome.ok) expect(outcome.error.code).toBe("not_implemented"); });
}); }
/** j00 absence contract. Owning job extends this SAME suite with behavioral assertions for double and real adapter. */
export function FederatedCallConfirmationSuite(required: { create: () => FederatedCallConfirmation }) {
describe("FederatedCallConfirmation stub contract", () => {
 it("confirm fails explicitly", async () => { const port = required.create(); const outcome = await port.confirm({} as Parameters<FederatedCallConfirmation["confirm"]>[0]); expect(outcome.ok).toBe(false); if (!outcome.ok) expect(outcome.error.code).toBe("not_implemented"); });
}); }
/** j00 absence contract. Owning job extends this SAME suite with behavioral assertions for double and real adapter. */
export function ExternalMcpToolApprovalRepoPortSuite(required: { create: () => ExternalMcpToolApprovalRepoPort }) {
describe("ExternalMcpToolApprovalRepoPort stub contract", () => {
 it("get fails explicitly", async () => { const port = required.create(); const outcome = await port.get({} as Parameters<ExternalMcpToolApprovalRepoPort["get"]>[0]); expect(outcome.ok).toBe(false); if (!outcome.ok) expect(outcome.error.code).toBe("not_implemented"); });
}); }
/** j00 absence contract. Owning job extends this SAME suite with behavioral assertions for double and real adapter. */
export function FederatedDispatchGatePortSuite(required: { create: () => FederatedDispatchGatePort }) {
describe("FederatedDispatchGatePort stub contract", () => {
 it("authorize fails explicitly", async () => { const port = required.create(); const outcome = await port.authorize({} as Parameters<FederatedDispatchGatePort["authorize"]>[0]); expect(outcome.ok).toBe(false); if (!outcome.ok) expect(outcome.error.code).toBe("not_implemented"); });
}); }
/** j00 absence contract. Owning job extends this SAME suite with behavioral assertions for double and real adapter. */
export function FederationAuditPortSuite(required: { create: () => FederationAuditPort }) {
describe("FederationAuditPort stub contract", () => {
 it("record fails explicitly", async () => { const port = required.create(); const outcome = await port.record({} as Parameters<FederationAuditPort["record"]>[0]); expect(outcome.ok).toBe(false); if (!outcome.ok) expect(outcome.error.code).toBe("not_implemented"); });
}); }
/** j00 absence contract. Owning job extends this SAME suite with behavioral assertions for double and real adapter. */
export function ToolRegistryPortSuite(required: { create: () => ToolRegistryPort }) {
describe("ToolRegistryPort stub contract", () => {
 it("register fails explicitly", async () => { const port = required.create(); const outcome = await port.register({} as Parameters<ToolRegistryPort["register"]>[0]); expect(outcome.ok).toBe(false); if (!outcome.ok) expect(outcome.error.code).toBe("not_implemented"); });
 it("unregister fails explicitly", async () => { const port = required.create(); const outcome = await port.unregister({} as Parameters<ToolRegistryPort["unregister"]>[0]); expect(outcome.ok).toBe(false); if (!outcome.ok) expect(outcome.error.code).toBe("not_implemented"); });
 it("reset fails explicitly", async () => { const port = required.create(); const outcome = await port.reset({} as Parameters<ToolRegistryPort["reset"]>[0]); expect(outcome.ok).toBe(false); if (!outcome.ok) expect(outcome.error.code).toBe("not_implemented"); });
 it("dispose fails explicitly", async () => { const port = required.create(); const outcome = await port.dispose({} as Parameters<ToolRegistryPort["dispose"]>[0]); expect(outcome.ok).toBe(false); if (!outcome.ok) expect(outcome.error.code).toBe("not_implemented"); });
}); }
