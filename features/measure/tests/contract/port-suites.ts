import { describe, it, expect } from "vitest";
import type { MeasureRepoPort, MeasurementShareabilityPort, ConversionDeliveryPort, PlatformReportingPort, MeasureJobPort, TrackedLinkPort, MeasureAuditPort } from "../../src/ports.js";
/** j00 absence contract. Owning job extends this SAME suite with behavioral assertions for double and real adapter. */
export function MeasureRepoPortSuite(required: { create: () => MeasureRepoPort }) {
describe("MeasureRepoPort stub contract", () => {
 it("appendConversion fails explicitly", async () => { const port = required.create(); const outcome = await port.appendConversion({} as Parameters<MeasureRepoPort["appendConversion"]>[0]); expect(outcome.ok).toBe(false); if (!outcome.ok) expect(outcome.error.code).toBe("not_implemented"); });
 it("appendSnapshot fails explicitly", async () => { const port = required.create(); const outcome = await port.appendSnapshot({} as Parameters<MeasureRepoPort["appendSnapshot"]>[0]); expect(outcome.ok).toBe(false); if (!outcome.ok) expect(outcome.error.code).toBe("not_implemented"); });
}); }
/** j00 absence contract. Owning job extends this SAME suite with behavioral assertions for double and real adapter. */
export function MeasurementShareabilityPortSuite(required: { create: () => MeasurementShareabilityPort }) {
describe("MeasurementShareabilityPort stub contract", () => {
 it("assess fails explicitly", async () => { const port = required.create(); const outcome = await port.assess({} as Parameters<MeasurementShareabilityPort["assess"]>[0]); expect(outcome.ok).toBe(false); if (!outcome.ok) expect(outcome.error.code).toBe("not_implemented"); });
}); }
/** j00 absence contract. Owning job extends this SAME suite with behavioral assertions for double and real adapter. */
export function ConversionDeliveryPortSuite(required: { create: () => ConversionDeliveryPort }) {
describe("ConversionDeliveryPort stub contract", () => {
 it("deliver fails explicitly", async () => { const port = required.create(); const outcome = await port.deliver({} as Parameters<ConversionDeliveryPort["deliver"]>[0]); expect(outcome.ok).toBe(false); if (!outcome.ok) expect(outcome.error.code).toBe("not_implemented"); });
}); }
/** j00 absence contract. Owning job extends this SAME suite with behavioral assertions for double and real adapter. */
export function PlatformReportingPortSuite(required: { create: () => PlatformReportingPort }) {
describe("PlatformReportingPort stub contract", () => {
 it("snapshot fails explicitly", async () => { const port = required.create(); const outcome = await port.snapshot({} as Parameters<PlatformReportingPort["snapshot"]>[0]); expect(outcome.ok).toBe(false); if (!outcome.ok) expect(outcome.error.code).toBe("not_implemented"); });
}); }
/** j00 absence contract. Owning job extends this SAME suite with behavioral assertions for double and real adapter. */
export function MeasureJobPortSuite(required: { create: () => MeasureJobPort }) {
describe("MeasureJobPort stub contract", () => {
 it("enqueue fails explicitly", async () => { const port = required.create(); const outcome = await port.enqueue({} as Parameters<MeasureJobPort["enqueue"]>[0]); expect(outcome.ok).toBe(false); if (!outcome.ok) expect(outcome.error.code).toBe("not_implemented"); });
}); }
/** j00 absence contract. Owning job extends this SAME suite with behavioral assertions for double and real adapter. */
export function TrackedLinkPortSuite(required: { create: () => TrackedLinkPort }) {
describe("TrackedLinkPort stub contract", () => {
 it("create fails explicitly", async () => { const port = required.create(); const outcome = await port.create({} as Parameters<TrackedLinkPort["create"]>[0]); expect(outcome.ok).toBe(false); if (!outcome.ok) expect(outcome.error.code).toBe("not_implemented"); });
}); }
/** j00 absence contract. Owning job extends this SAME suite with behavioral assertions for double and real adapter. */
export function MeasureAuditPortSuite(required: { create: () => MeasureAuditPort }) {
describe("MeasureAuditPort stub contract", () => {
 it("record fails explicitly", async () => { const port = required.create(); const outcome = await port.record({} as Parameters<MeasureAuditPort["record"]>[0]); expect(outcome.ok).toBe(false); if (!outcome.ok) expect(outcome.error.code).toBe("not_implemented"); });
}); }
