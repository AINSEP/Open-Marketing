import { describe, it, expect } from "vitest";
import type { CreativeRepoPort, GenerationCapabilityPort, CreativeAssetPort, CreativeJobPort, CreativeSpendPort, CreativeAuditPort } from "../../src/ports.js";
/** j00 absence contract. Owning job extends this SAME suite with behavioral assertions for double and real adapter. */
export function CreativeRepoPortSuite(required: { create: () => CreativeRepoPort }) {
describe("CreativeRepoPort stub contract", () => {
 it("save fails explicitly", async () => { const port = required.create(); const outcome = await port.save({} as Parameters<CreativeRepoPort["save"]>[0]); expect(outcome.ok).toBe(false); if (!outcome.ok) expect(outcome.error.code).toBe("not_implemented"); });
 it("get fails explicitly", async () => { const port = required.create(); const outcome = await port.get({} as Parameters<CreativeRepoPort["get"]>[0]); expect(outcome.ok).toBe(false); if (!outcome.ok) expect(outcome.error.code).toBe("not_implemented"); });
 it("appendCost fails explicitly", async () => { const port = required.create(); const outcome = await port.appendCost({} as Parameters<CreativeRepoPort["appendCost"]>[0]); expect(outcome).toMatchObject({ ok: false, error: { code: "not_implemented" } }); });
}); }
/** j00 absence contract. Owning job extends this SAME suite with behavioral assertions for double and real adapter. */
export function GenerationCapabilityPortSuite(required: { create: () => GenerationCapabilityPort }) {
describe("GenerationCapabilityPort stub contract", () => {
 it("quote fails explicitly", async () => { const port = required.create(); const outcome = await port.quote({} as Parameters<GenerationCapabilityPort["quote"]>[0]); expect(outcome.ok).toBe(false); if (!outcome.ok) expect(outcome.error.code).toBe("not_implemented"); });
 it("generate fails explicitly", async () => { const port = required.create(); const outcome = await port.generate({} as Parameters<GenerationCapabilityPort["generate"]>[0]); expect(outcome.ok).toBe(false); if (!outcome.ok) expect(outcome.error.code).toBe("not_implemented"); });
 it("status fails explicitly", async () => { const port = required.create(); const outcome = await port.status({} as Parameters<GenerationCapabilityPort["status"]>[0]); expect(outcome.ok).toBe(false); if (!outcome.ok) expect(outcome.error.code).toBe("not_implemented"); });
 it("pollDue fails explicitly", async () => { const port = required.create(); const outcome = await port.pollDue({} as Parameters<GenerationCapabilityPort["pollDue"]>[0]); expect(outcome).toMatchObject({ ok: false, error: { code: "not_implemented" } }); });
 it("recover fails explicitly", async () => { const port = required.create(); const outcome = await port.recover({} as Parameters<GenerationCapabilityPort["recover"]>[0]); expect(outcome).toMatchObject({ ok: false, error: { code: "not_implemented" } }); });
 it("cancel fails explicitly", async () => { const port = required.create(); const outcome = await port.cancel({} as Parameters<GenerationCapabilityPort["cancel"]>[0]); expect(outcome).toMatchObject({ ok: false, error: { code: "not_implemented" } }); });
}); }
/** j00 absence contract. Owning job extends this SAME suite with behavioral assertions for double and real adapter. */
export function CreativeAssetPortSuite(required: { create: () => CreativeAssetPort }) {
describe("CreativeAssetPort stub contract", () => {
 it("import fails explicitly", async () => { const port = required.create(); const outcome = await port.import({} as Parameters<CreativeAssetPort["import"]>[0]); expect(outcome.ok).toBe(false); if (!outcome.ok) expect(outcome.error.code).toBe("not_implemented"); });
 it("recordProvenance fails explicitly", async () => { const port = required.create(); const outcome = await port.recordProvenance({} as Parameters<CreativeAssetPort["recordProvenance"]>[0]); expect(outcome).toMatchObject({ ok: false, error: { code: "not_implemented" } }); });
 it("recordCost fails explicitly", async () => { const port = required.create(); const outcome = await port.recordCost({} as Parameters<CreativeAssetPort["recordCost"]>[0]); expect(outcome).toMatchObject({ ok: false, error: { code: "not_implemented" } }); });
}); }
/** j00 absence contract. Owning job extends this SAME suite with behavioral assertions for double and real adapter. */
export function CreativeJobPortSuite(required: { create: () => CreativeJobPort }) {
describe("CreativeJobPort stub contract", () => {
 it("enqueue fails explicitly", async () => { const port = required.create(); const outcome = await port.enqueue({} as Parameters<CreativeJobPort["enqueue"]>[0]); expect(outcome.ok).toBe(false); if (!outcome.ok) expect(outcome.error.code).toBe("not_implemented"); });
}); }
/** j00 absence contract. Owning job extends this SAME suite with behavioral assertions for double and real adapter. */
export function CreativeSpendPortSuite(required: { create: () => CreativeSpendPort }) {
describe("CreativeSpendPort stub contract", () => {
 it("assess fails explicitly", async () => { const port = required.create(); const outcome = await port.assess({} as Parameters<CreativeSpendPort["assess"]>[0]); expect(outcome.ok).toBe(false); if (!outcome.ok) expect(outcome.error.code).toBe("not_implemented"); });
}); }
/** j00 absence contract. Owning job extends this SAME suite with behavioral assertions for double and real adapter. */
export function CreativeAuditPortSuite(required: { create: () => CreativeAuditPort }) {
describe("CreativeAuditPort stub contract", () => {
 it("record fails explicitly", async () => { const port = required.create(); const outcome = await port.record({} as Parameters<CreativeAuditPort["record"]>[0]); expect(outcome.ok).toBe(false); if (!outcome.ok) expect(outcome.error.code).toBe("not_implemented"); });
}); }
