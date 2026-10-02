import { describe, it, expect } from "vitest";
import type { CampaignRepoPort, CampaignCapabilityPort, CampaignAssetPort, CampaignSafetyPort, CampaignJobPort, CampaignAuditPort } from "../../src/ports.js";
/** j00 absence contract. Owning job extends this SAME suite with behavioral assertions for double and real adapter. */
export function CampaignRepoPortSuite(required: { create: () => CampaignRepoPort }) {
describe("CampaignRepoPort stub contract", () => {
 it("save fails explicitly", async () => { const port = required.create(); const outcome = await port.save({} as Parameters<CampaignRepoPort["save"]>[0]); expect(outcome.ok).toBe(false); if (!outcome.ok) expect(outcome.error.code).toBe("not_implemented"); });
 it("observe fails explicitly", async () => { const port = required.create(); const outcome = await port.observe({} as Parameters<CampaignRepoPort["observe"]>[0]); expect(outcome.ok).toBe(false); if (!outcome.ok) expect(outcome.error.code).toBe("not_implemented"); });
}); }
/** j00 absence contract. Owning job extends this SAME suite with behavioral assertions for double and real adapter. */
export function CampaignCapabilityPortSuite(required: { create: () => CampaignCapabilityPort }) {
describe("CampaignCapabilityPort stub contract", () => {
 it("createPaused fails explicitly", async () => { const port = required.create(); const outcome = await port.createPaused({} as Parameters<CampaignCapabilityPort["createPaused"]>[0]); expect(outcome.ok).toBe(false); if (!outcome.ok) expect(outcome.error.code).toBe("not_implemented"); });
 it("launch fails explicitly", async () => { const port = required.create(); const outcome = await port.launch({} as Parameters<CampaignCapabilityPort["launch"]>[0]); expect(outcome.ok).toBe(false); if (!outcome.ok) expect(outcome.error.code).toBe("not_implemented"); });
}); }
/** j00 absence contract. Owning job extends this SAME suite with behavioral assertions for double and real adapter. */
export function CampaignAssetPortSuite(required: { create: () => CampaignAssetPort }) {
describe("CampaignAssetPort stub contract", () => {
 it("resolve fails explicitly", async () => { const port = required.create(); const outcome = await port.resolve({} as Parameters<CampaignAssetPort["resolve"]>[0]); expect(outcome.ok).toBe(false); if (!outcome.ok) expect(outcome.error.code).toBe("not_implemented"); });
}); }
/** j00 absence contract. Owning job extends this SAME suite with behavioral assertions for double and real adapter. */
export function CampaignSafetyPortSuite(required: { create: () => CampaignSafetyPort }) {
describe("CampaignSafetyPort stub contract", () => {
 it("authorize fails explicitly", async () => { const port = required.create(); const outcome = await port.authorize({} as Parameters<CampaignSafetyPort["authorize"]>[0]); expect(outcome.ok).toBe(false); if (!outcome.ok) expect(outcome.error.code).toBe("not_implemented"); });
}); }
/** j00 absence contract. Owning job extends this SAME suite with behavioral assertions for double and real adapter. */
export function CampaignJobPortSuite(required: { create: () => CampaignJobPort }) {
describe("CampaignJobPort stub contract", () => {
 it("enqueue fails explicitly", async () => { const port = required.create(); const outcome = await port.enqueue({} as Parameters<CampaignJobPort["enqueue"]>[0]); expect(outcome.ok).toBe(false); if (!outcome.ok) expect(outcome.error.code).toBe("not_implemented"); });
}); }
/** j00 absence contract. Owning job extends this SAME suite with behavioral assertions for double and real adapter. */
export function CampaignAuditPortSuite(required: { create: () => CampaignAuditPort }) {
describe("CampaignAuditPort stub contract", () => {
 it("record fails explicitly", async () => { const port = required.create(); const outcome = await port.record({} as Parameters<CampaignAuditPort["record"]>[0]); expect(outcome.ok).toBe(false); if (!outcome.ok) expect(outcome.error.code).toBe("not_implemented"); });
}); }
