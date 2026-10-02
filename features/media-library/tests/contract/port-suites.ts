import { describe, it, expect } from "vitest";
import type { MediaRepoPort, JiniMediaPort, BlobStorePort, GuardedAssetImportPort, ImageTransformPort, MediaAuditPort } from "../../src/ports.js";
/** j00 absence scaffold; the feature job replaces it with ONE behavioral suite for both adapters. */
export function MediaRepoPortSuite(required: { create: () => MediaRepoPort }) {
describe("MediaRepoPort stub contract", () => {
 it("saveCrop fails explicitly", async () => { const port = required.create(); const outcome = await port.saveCrop({} as Parameters<MediaRepoPort["saveCrop"]>[0]); expect(outcome).toMatchObject({ ok: false, error: { code: "not_implemented" } }); });
 it("appendProvenance fails explicitly", async () => { const port = required.create(); const outcome = await port.appendProvenance({} as Parameters<MediaRepoPort["appendProvenance"]>[0]); expect(outcome).toMatchObject({ ok: false, error: { code: "not_implemented" } }); });
 it("appendCost fails explicitly", async () => { const port = required.create(); const outcome = await port.appendCost({} as Parameters<MediaRepoPort["appendCost"]>[0]); expect(outcome).toMatchObject({ ok: false, error: { code: "not_implemented" } }); });
 it("evidence fails explicitly", async () => { const port = required.create(); const outcome = await port.evidence({} as Parameters<MediaRepoPort["evidence"]>[0]); expect(outcome).toMatchObject({ ok: false, error: { code: "not_implemented" } }); });
}); }
/** j00 absence scaffold; the feature job replaces it with ONE behavioral suite for both adapters. */
export function JiniMediaPortSuite(required: { create: () => JiniMediaPort }) {
describe("JiniMediaPort stub contract", () => {
 it("save fails explicitly", async () => { const port = required.create(); const outcome = await port.save({} as Parameters<JiniMediaPort["save"]>[0]); expect(outcome).toMatchObject({ ok: false, error: { code: "not_implemented" } }); });
 it("get fails explicitly", async () => { const port = required.create(); const outcome = await port.get({} as Parameters<JiniMediaPort["get"]>[0]); expect(outcome).toMatchObject({ ok: false, error: { code: "not_implemented" } }); });
 it("findByDigest fails explicitly", async () => { const port = required.create(); const outcome = await port.findByDigest({} as Parameters<JiniMediaPort["findByDigest"]>[0]); expect(outcome).toMatchObject({ ok: false, error: { code: "not_implemented" } }); });
 it("list fails explicitly", async () => { const port = required.create(); const outcome = await port.list({} as Parameters<JiniMediaPort["list"]>[0]); expect(outcome).toMatchObject({ ok: false, error: { code: "not_implemented" } }); });
}); }
/** j00 absence scaffold; the feature job replaces it with ONE behavioral suite for both adapters. */
export function BlobStorePortSuite(required: { create: () => BlobStorePort }) {
describe("BlobStorePort stub contract", () => {
 it("put fails explicitly", async () => { const port = required.create(); const outcome = await port.put({} as Parameters<BlobStorePort["put"]>[0]); expect(outcome).toMatchObject({ ok: false, error: { code: "not_implemented" } }); });
 it("read fails explicitly", async () => { const port = required.create(); const outcome = await port.read({} as Parameters<BlobStorePort["read"]>[0]); expect(outcome).toMatchObject({ ok: false, error: { code: "not_implemented" } }); });
 it("remove fails explicitly", async () => { const port = required.create(); const outcome = await port.remove({} as Parameters<BlobStorePort["remove"]>[0]); expect(outcome).toMatchObject({ ok: false, error: { code: "not_implemented" } }); });
}); }
/** j00 absence scaffold; the feature job replaces it with ONE behavioral suite for both adapters. */
export function GuardedAssetImportPortSuite(required: { create: () => GuardedAssetImportPort }) {
describe("GuardedAssetImportPort stub contract", () => {
 it("import fails explicitly", async () => { const port = required.create(); const outcome = await port.import({} as Parameters<GuardedAssetImportPort["import"]>[0]); expect(outcome).toMatchObject({ ok: false, error: { code: "not_implemented" } }); });
}); }
/** j00 absence scaffold; the feature job replaces it with ONE behavioral suite for both adapters. */
export function ImageTransformPortSuite(required: { create: () => ImageTransformPort }) {
describe("ImageTransformPort stub contract", () => {
 it("crop fails explicitly", async () => { const port = required.create(); const outcome = await port.crop({} as Parameters<ImageTransformPort["crop"]>[0]); expect(outcome).toMatchObject({ ok: false, error: { code: "not_implemented" } }); });
}); }
/** j00 absence scaffold; the feature job replaces it with ONE behavioral suite for both adapters. */
export function MediaAuditPortSuite(required: { create: () => MediaAuditPort }) {
describe("MediaAuditPort stub contract", () => {
 it("record fails explicitly", async () => { const port = required.create(); const outcome = await port.record({} as Parameters<MediaAuditPort["record"]>[0]); expect(outcome).toMatchObject({ ok: false, error: { code: "not_implemented" } }); });
}); }
