import { beforeEach, afterEach, describe, it, expect } from 'vitest';
import type { MediaRepoPort, JiniMediaPort, BlobStorePort, GuardedAssetImportPort, ImageTransformPort, MediaAuditPort, JiniMediaDependencies } from '../../index.js';
import { bytes, context, foreignContext, otherOwner, digest, provenance, seedAsset, value } from '../fixtures.js';
import { computeBlobStorageKey } from '@jini-ai/cms/media';

type Fixture<T> = { port: T; dispose?: () => Promise<void> };
type Create<T> = { create: () => Fixture<T> | Promise<Fixture<T>> };
/** The SAME behavioral suite is registered for memory and injected SQLite adapters. */
export function MediaRepoPortSuite(required: Create<MediaRepoPort>): void {
  describe('MediaRepoPort behavior', () => {
    let fixture: Fixture<MediaRepoPort>;
    beforeEach(async () => { fixture = await required.create(); });
    afterEach(async () => { await fixture.dispose?.(); });
    it('retains evidence without output and supports later asset links', async () => {
      expect(await fixture.port.appendProvenance({ context, link: { provenance } })).toEqual({ ok: true, value: undefined });
      expect(value({ outcome: await fixture.port.evidence({ context, operationId: provenance.operationId }) }).provenance).toEqual([{ provenance }]);
      await fixture.port.appendProvenance({ context, link: { provenance, assetId: 'asset' } });
      await fixture.port.appendProvenance({ context, link: { provenance, assetId: 'asset' } });
      expect(value({ outcome: await fixture.port.evidence({ context, operationId: provenance.operationId }) }).provenance).toEqual([{ provenance, assetId: 'asset' }]);
    });
    it('conflicting provenance never overwrites a previous operation', async () => {
      await fixture.port.appendProvenance({ context, link: { provenance } });
      expect(await fixture.port.appendProvenance({ context, link: { provenance: { ...provenance, prompt: 'changed' }, assetId: 'asset' } })).toMatchObject({ ok: false, error: { code: 'conflict' } });
      expect(value({ outcome: await fixture.port.evidence({ context, operationId: provenance.operationId }) }).provenance).toEqual([{ provenance }]);
    });
    it('appends costs once and linked corrections without deleting originals', async () => {
      const cost = { observationId: 'observation', operationId: 'operation', amount: { currency: 'USD', minorUnits: 10 }, kind: 'estimated' as const };
      expect(await fixture.port.appendCost({ context, cost })).toEqual({ ok: true, value: undefined });
      await fixture.port.appendCost({ context, cost });
      expect(await fixture.port.appendCost({ context, cost: { ...cost, amount: { ...cost.amount, minorUnits: 20 } } })).toMatchObject({ ok: false, error: { code: 'conflict' } });
      const correction = { ...cost, observationId: 'correction', kind: 'correction' as const, correctionOf: 'observation', amount: { currency: 'USD', minorUnits: 4 } };
      expect(await fixture.port.appendCost({ context, cost: correction })).toEqual({ ok: true, value: undefined });
      expect(value({ outcome: await fixture.port.evidence({ context, operationId: 'operation' }) }).costs).toEqual(expect.arrayContaining([cost, correction]));
      expect(value({ outcome: await fixture.port.evidence({ context, operationId: 'operation' }) }).costs).toHaveLength(2);
    });
    it('rejects correction to absent operation or a different currency', async () => {
      const cost = { observationId: 'actual', operationId: 'operation', amount: { currency: 'USD', minorUnits: 10 }, kind: 'actual' as const };
      await fixture.port.appendCost({ context, cost });
      const correction = { ...cost, observationId: 'correction', kind: 'correction' as const, correctionOf: 'actual' };
      expect(await fixture.port.appendCost({ context, cost: { ...correction, operationId: 'different' } })).toMatchObject({ ok: false, error: { code: 'conflict' } });
      expect(await fixture.port.appendCost({ context, cost: { ...correction, amount: { currency: 'EUR', minorUnits: 10 } } })).toMatchObject({ ok: false, error: { code: 'conflict' } });
    });
    it('denies cross-workspace and cross-owner reads/writes', async () => {
      await fixture.port.appendProvenance({ context, link: { provenance } });
      for (const caller of [foreignContext, otherOwner]) {
        expect(await fixture.port.evidence({ context: caller, operationId: 'operation' })).toMatchObject({ ok: false, error: { code: 'forbidden' } });
        expect(await fixture.port.appendCost({ context: caller, cost: { observationId: 'cost', operationId: 'operation', amount: { currency: 'USD', minorUnits: 1 }, kind: 'actual' } })).toMatchObject({ ok: false, error: { code: 'forbidden' } });
      }
    });
    it('rejects forged owner context, malformed money and aborted calls', async () => {
      expect(await fixture.port.evidence({ context: { ...context, principal: { kind: 'owner', ownerId: 'forged' } }, operationId: 'operation' })).toMatchObject({ ok: false, error: { code: 'forbidden' } });
      expect(await fixture.port.appendCost({ context, cost: { observationId: 'cost', operationId: 'operation', amount: { currency: 'usd', minorUnits: -1 }, kind: 'actual' } })).toMatchObject({ ok: false, error: { code: 'invalid_input' } });
      expect(await fixture.port.evidence({ context, operationId: 'operation' }, { signal: AbortSignal.abort() })).toMatchObject({ ok: false, error: { code: 'cancelled' } });
    });
    it('saves immutable crop links and rejects a foreign rendition', async () => {
      const crop = { assetId: 'asset', placement: 'ad-square', presetVersion: 1, cropId: 'crop', rendition: { id: 'rendition', workspaceId: 'workspace', assetId: 'asset', transformName: 'om-ad-square-v1', version: 1, storageKey: computeBlobStorageKey({ workspaceId: 'workspace', sha256: 'a'.repeat(64) }), createdAt: new Date(1000).toISOString() } };
      expect(await fixture.port.saveCrop({ context, crop })).toEqual({ ok: true, value: crop });
      expect(await fixture.port.saveCrop({ context, crop })).toEqual({ ok: true, value: crop });
      expect(await fixture.port.saveCrop({ context, crop: { ...crop, cropId: 'changed' } })).toMatchObject({ ok: false, error: { code: 'conflict' } });
      expect(await fixture.port.saveCrop({ context, crop: { ...crop, rendition: { ...crop.rendition, workspaceId: 'foreign' } } })).toMatchObject({ ok: false, error: { code: 'forbidden' } });
    });
  });
}
/** Same canonical wrapper contract for Jini-backed memory and explicit injected adapter compositions. */
export function JiniMediaPortSuite(required: { create: () => { port: JiniMediaPort; deps: JiniMediaDependencies } }): void {
  describe('JiniMediaPort behavior', () => {
    it('reads canonical assets, keeps Jini dedupe and refuses source replacement', async () => {
      const { port, deps } = required.create();
      const original = await seedAsset({ deps });
      const second = await seedAsset({ deps, filename: 'second.png' });
      expect(second.record.id).not.toBe(original.record.id);
      expect(second.blob).toEqual(original.blob);
      expect(await port.save({ context, asset: original })).toEqual({ ok: true, value: original });
      expect(value({ outcome: await port.get({ context, assetId: original.record.id }) })).toEqual(original);
      expect(value({ outcome: await port.findByDigest({ context, contentDigest: digest }) })?.blob.sha256).toBe(digest);
      expect(await port.save({ context, asset: { ...original, record: { ...original.record, title: 'replacement' } } })).toMatchObject({ ok: false, error: { code: 'conflict' } });
    });
    it('bounds listing and provides complete nonoverlapping pages', async () => {
      const { port, deps } = required.create();
      await seedAsset({ deps }); await seedAsset({ deps }); await seedAsset({ deps });
      const first = value({ outcome: await port.list({ context, query: { limit: 2 } }) });
      expect(first.items).toHaveLength(2); expect(first.cursor).not.toBeNull();
      const second = value({ outcome: await port.list({ context, query: { limit: 2, cursor: first.cursor! } }) });
      expect(second.items).toHaveLength(1); expect(second.cursor).toBeNull();
      expect(new Set([...first.items, ...second.items].map(asset => asset.record.id)).size).toBe(3);
      expect(await port.list({ context, query: { limit: 101 } })).toMatchObject({ ok: false, error: { code: 'invalid_input' } });
      expect(await port.list({ context, query: { limit: 1, cursor: 'foreign' } })).toMatchObject({ ok: false, error: { code: 'forbidden' } });
    });
    it('fails closed on inaccessible assets and foreign scope', async () => {
      const { port, deps } = required.create(); const asset = await seedAsset({ deps });
      expect(await port.get({ context, assetId: 'absent' })).toMatchObject({ ok: false, error: { code: 'forbidden' } });
      for (const caller of [foreignContext, otherOwner]) {
        expect(await port.get({ context: caller, assetId: asset.record.id })).toMatchObject({ ok: false, error: { code: 'forbidden' } });
        expect(await port.save({ context: caller, asset })).toMatchObject({ ok: false, error: { code: 'forbidden' } });
        expect(await port.findByDigest({ context: caller, contentDigest: digest })).toMatchObject({ ok: false, error: { code: 'forbidden' } });
        expect(await port.list({ context: caller, query: { limit: 1 } })).toMatchObject({ ok: false, error: { code: 'forbidden' } });
      }
    });
  });
}
/** Same byte-store behavior against Jini memory and a real temporary filesystem store. */
export function BlobStorePortSuite(required: Create<BlobStorePort>): void {
  describe('BlobStorePort behavior', () => {
    let fixture: Fixture<BlobStorePort>;
    beforeEach(async () => { fixture = await required.create(); });
    afterEach(async () => { await fixture.dispose?.(); });
    it('content-addresses whole bytes, reports create-only dedupe, and copies inputs/outputs', async () => {
      const input = { workspaceId: 'workspace', sha256: digest, bytes: bytes.slice() };
      const stored = value({ outcome: await fixture.port.put({ context, input }) });
      expect(stored.written).toBe(true);
      input.bytes.fill(0);
      expect(value({ outcome: await fixture.port.read({ context, storageKey: stored.storageKey }) })).toEqual(bytes);
      expect(value({ outcome: await fixture.port.put({ context, input: { ...input, bytes } }) }).written).toBe(false);
      const read = value({ outcome: await fixture.port.read({ context, storageKey: stored.storageKey }) }); read.fill(0);
      expect(value({ outcome: await fixture.port.read({ context, storageKey: stored.storageKey }) })).toEqual(bytes);
      expect(await fixture.port.remove({ context, storageKey: stored.storageKey })).toEqual({ ok: true, value: undefined });
      expect(await fixture.port.remove({ context, storageKey: stored.storageKey })).toEqual({ ok: true, value: undefined });
      expect(await fixture.port.read({ context, storageKey: stored.storageKey })).toMatchObject({ ok: false, error: { code: 'unavailable' } });
    });
    it('rejects digest forgery, traversal, foreign keys and invalid sizes', async () => {
      expect(await fixture.port.put({ context, input: { workspaceId: 'workspace', sha256: 'a'.repeat(64), bytes } })).toMatchObject({ ok: false, error: { code: 'invalid_input' } });
      expect(await fixture.port.put({ context, input: { workspaceId: 'workspace', sha256: digest, bytes: new Uint8Array() } })).toMatchObject({ ok: false, error: { code: 'limit_exceeded' } });
      expect(await fixture.port.read({ context, storageKey: '../../secret' })).toMatchObject({ ok: false, error: { code: 'invalid_input' } });
      const key = computeBlobStorageKey({ workspaceId: 'foreign', sha256: digest });
      expect(await fixture.port.remove({ context, storageKey: key })).toMatchObject({ ok: false, error: { code: 'forbidden' } });
      expect(await fixture.port.put({ context: otherOwner, input: { workspaceId: 'workspace', sha256: digest, bytes } })).toMatchObject({ ok: false, error: { code: 'forbidden' } });
    });
    it('concurrent identical writers create only one object', async () => {
      const calls = [1, 2, 3].map(async () => fixture.port.put({ context, input: { workspaceId: 'workspace', sha256: digest, bytes } }));
      const results = await Promise.all(calls);
      expect(results.map(outcome => value({ outcome }).written).filter(Boolean)).toHaveLength(1);
      expect(value({ outcome: await fixture.port.read({ context, storageKey: value({ outcome: results[0] }).storageKey }) })).toEqual(bytes);
    });
  });
}
/** The deferred seam is explicitly tested as unavailable; these are not SSRF ingress acceptance tests. */
export function GuardedAssetImportPortSuite(required: { create: () => GuardedAssetImportPort }): void {
  describe('GuardedAssetImportPort deferred contract', () => {
    it('valid URL requests remain not_implemented, including unsafe network destinations', async () => {
      const port = required.create();
      for (const sourceUrl of ['https://example.com/image.png', 'http://127.0.0.1/', 'http://169.254.169.254/']) {
        expect(await port.import({ context, request: { sourceUrl, operationId: 'operation', expectedDigest: digest, provenance } })).toMatchObject({ ok: false, error: { code: 'not_implemented' } });
      }
    });
    it('rejects malformed provenance and foreign contexts before the unavailable seam', async () => {
      const port = required.create();
      const request = { sourceUrl: 'https://example.com/image.png', operationId: 'different', expectedDigest: digest, provenance };
      expect(await port.import({ context, request })).toMatchObject({ ok: false, error: { code: 'invalid_input' } });
      expect(await port.import({ context: foreignContext, request })).toMatchObject({ ok: false, error: { code: 'forbidden' } });
    });
  });
}
/** Same Jini transform orchestration contract for the named memory and injected adapters. */
export function ImageTransformPortSuite(required: { create: () => { port: ImageTransformPort; deps: JiniMediaDependencies } }): void {
  describe('ImageTransformPort behavior', () => {
    it('preserves original bytes and generates one immutable placement rendition on repeated calls', async () => {
      const { deps, port } = required.create(); const original = await seedAsset({ deps });
      const request = { assetId: original.record.id, placement: 'ad-square', presetVersion: 1 };
      const first = value({ outcome: await port.crop({ context, request }) });
      const second = value({ outcome: await port.crop({ context, request }) });
      expect(first).toEqual(second); expect(first.rendition.storageKey).not.toBe(original.blob.storageKey);
      expect(await deps.blobStore.get({ storageKey: original.blob.storageKey })).toEqual(bytes);
      expect(await deps.mediaRepo.findById({ workspaceId: 'workspace', id: original.record.id })).toEqual(original.record);
      const definition = await deps.transformRepo.findByNameVersion({ workspaceId: 'workspace', name: 'om-ad-square-v1', version: 1 });
      expect(definition?.params).toEqual({ width: 1080, height: 1080, fit: 'cover', format: 'webp' });
    });
    it('rejects unknown placement/version, missing originals and foreign contexts', async () => {
      const { port } = required.create();
      expect(await port.crop({ context, request: { assetId: 'absent', placement: 'unknown', presetVersion: 1 } })).toMatchObject({ ok: false, error: { code: 'invalid_input' } });
      expect(await port.crop({ context, request: { assetId: 'absent', placement: 'ad-square', presetVersion: 2 } })).toMatchObject({ ok: false, error: { code: 'invalid_input' } });
      expect(await port.crop({ context, request: { assetId: 'absent', placement: 'ad-square', presetVersion: 1 } })).toMatchObject({ ok: false, error: { code: 'forbidden' } });
      expect(await port.crop({ context: foreignContext, request: { assetId: 'absent', placement: 'ad-square', presetVersion: 1 } })).toMatchObject({ ok: false, error: { code: 'forbidden' } });
    });
  });
}
export function MediaAuditPortSuite(required: Create<MediaAuditPort>): void {
  describe('MediaAuditPort behavior', () => {
    let fixture: Fixture<MediaAuditPort>;
    beforeEach(async () => { fixture = await required.create(); });
    afterEach(async () => { await fixture.dispose?.(); });
    it('repeated exact bindings are idempotent; changed bindings are conflicts', async () => {
      const input = { context, operationId: 'operation', assetId: 'asset' };
      expect(await fixture.port.record(input)).toEqual({ ok: true, value: undefined });
      expect(await fixture.port.record(input)).toEqual({ ok: true, value: undefined });
      expect(await fixture.port.record({ ...input, assetId: 'changed' })).toMatchObject({ ok: false, error: { code: 'conflict' } });
      expect(await fixture.port.record({ ...input, context: foreignContext })).toMatchObject({ ok: false, error: { code: 'forbidden' } });
    });
  });
}
