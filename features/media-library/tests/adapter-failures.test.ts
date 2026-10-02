import { it, expect, vi } from 'vitest';
import { InMemoryBlobStore } from '@jini-ai/cms/media';
import { createJiniBlobStore, createJiniMediaAdapter, createJiniImageTransform, createMemoryMediaObserver, createMemoryMediaRepo } from '../index.js';
import { bytes, context, dependencies, digest, seedAsset, value } from './fixtures.js';

it('ambiguous partial byte writes never delete shared bytes and fail integrity checks', async () => {
  const store = new InMemoryBlobStore(); const remove = vi.spyOn(store, 'remove');
  const originalPut = store.putIfAbsent.bind(store);
  store.putIfAbsent = async input => {
    await originalPut({ ...input, bytes: input.bytes.slice(0, 3) });
    throw new Error('Interrupted write');
  };
  const port = createJiniBlobStore({ scope: context.scope, store });
  const input = { context, input: { workspaceId: 'workspace', sha256: digest, bytes } };
  expect(await port.put(input)).toMatchObject({ ok: false, error: { code: 'unavailable' } });
  expect(remove).not.toHaveBeenCalled();
  store.putIfAbsent = originalPut;
  expect(await port.put(input)).toMatchObject({ ok: false, error: { code: 'unavailable' } });
  expect(await port.read({ context, storageKey: `ws/workspace/blobs/${digest.slice(0, 2)}/${digest}` })).toMatchObject({ ok: false, error: { code: 'unavailable' } });
});
it('reads refuse corrupt existing bytes instead of returning false success', async () => {
  const store = new InMemoryBlobStore(); const port = createJiniBlobStore({ scope: context.scope, store });
  const result = value({ outcome: await port.put({ context, input: { workspaceId: 'workspace', sha256: digest, bytes } }) });
  await store.put({ workspaceId: 'workspace', sha256: digest, bytes: Uint8Array.of(0) });
  expect(await port.read({ context, storageKey: result.storageKey })).toMatchObject({ ok: false, error: { code: 'unavailable' } });
});
it('tainted upstream scope and malformed records fail closed', async () => {
  const deps = dependencies(); const asset = await seedAsset({ deps });
  const port = createJiniMediaAdapter({ scope: context.scope, dependencies: deps });
  deps.mediaRepo.findById = vi.fn().mockResolvedValue({ ...asset.record, workspaceId: 'foreign' });
  expect(await port.get({ context, assetId: asset.record.id })).toMatchObject({ ok: false, error: { code: 'forbidden' } });
  deps.mediaRepo.list = vi.fn().mockResolvedValue([{ ...asset.record, source: { sha256: 'invalid' } }]);
  expect(await port.list({ context, query: { limit: 1 } })).toMatchObject({ ok: false, error: { code: 'unavailable' } });
  deps.mediaRepo.list = vi.fn().mockResolvedValue(Array(1001).fill(asset.record));
  expect(await port.list({ context, query: { limit: 1 } })).toMatchObject({ ok: false, error: { code: 'limit_exceeded' } });
});
it('invalid or conflicting placement geometry never changes a registered definition', async () => {
  const deps = dependencies(); const asset = await seedAsset({ deps });
  const input = { context, request: { assetId: asset.record.id, placement: 'ad-square', presetVersion: 1 } };
  const port = createJiniImageTransform({ scope: context.scope, dependencies: deps });
  expect((await port.crop(input)).ok).toBe(true);
  const changed = createJiniImageTransform({ scope: context.scope, dependencies: deps }, { placementPresets: [{ placement: 'ad-square', version: 1, params: { width: 1200, height: 1200, fit: 'cover', format: 'webp' } }] });
  expect(await changed.crop(input)).toMatchObject({ ok: false, error: { code: 'conflict' } });
  const invalid = createJiniImageTransform({ scope: context.scope, dependencies: deps }, { placementPresets: [{ placement: 'ad-square', version: 1, params: { width: 9000, height: 1080, fit: 'cover', format: 'webp' } }] });
  expect(await invalid.crop(input)).toMatchObject({ ok: false, error: { code: 'invalid_input' } });
  const nonExact = createJiniImageTransform({ scope: context.scope, dependencies: deps }, { placementPresets: [{ placement: 'ad-square', version: 1, params: { width: 1080, height: 1080, fit: 'inside', format: 'webp' } }] });
  expect(await nonExact.crop(input)).toMatchObject({ ok: false, error: { code: 'invalid_input' } });
});
it('concurrent crops share one immutable definition and rendition', async () => {
  const deps = dependencies(); const asset = await seedAsset({ deps });
  const first = createJiniImageTransform({ scope: context.scope, dependencies: deps });
  const second = createJiniImageTransform({ scope: context.scope, dependencies: deps });
  const input = { context, request: { assetId: asset.record.id, placement: 'ad-square', presetVersion: 1 } };
  const results = await Promise.all([first.crop(input), second.crop(input)]);
  expect(value({ outcome: results[0] })).toEqual(value({ outcome: results[1] }));
  expect(await deps.transformRepo.listByName({ workspaceId: 'workspace', name: 'om-ad-square-v1' })).toHaveLength(1);
});
it('observer double copies records and resets without shared state', () => {
  const observer = createMemoryMediaObserver({}); const separate = createMemoryMediaObserver({});
  const event = { operation: 'media.test', outcome: 'ok', correlationId: 'correlation', traceId: 'trace' };
  observer.observe(event); event.outcome = 'changed';
  expect(observer.events({})[0].outcome).toBe('ok'); expect(separate.events({})).toEqual([]);
  observer.reset({}); expect(observer.events({})).toEqual([]);
});
it('in-memory metadata copies persisted evidence rather than retaining caller references', async () => {
  const repo = createMemoryMediaRepo({ scope: context.scope });
  const cost = { observationId: 'observation', operationId: 'operation', amount: { currency: 'USD', minorUnits: 10 }, kind: 'actual' as const };
  await repo.appendCost({ context, cost }); cost.amount.minorUnits = 999;
  expect(value({ outcome: await repo.evidence({ context, operationId: 'operation' }) }).costs[0].amount.minorUnits).toBe(10);
});
it('a transformer cannot mutate original byte-store references', async () => {
  const deps = dependencies(); const asset = await seedAsset({ deps });
  const transform = deps.imageTransformer.transform.bind(deps.imageTransformer);
  deps.imageTransformer.transform = async input => {
    const output = await transform(input);
    input.bytes.fill(0);
    return output;
  };
  const port = createJiniImageTransform({ scope: context.scope, dependencies: deps });
  expect((await port.crop({ context, request: { assetId: asset.record.id, placement: 'ad-square', presetVersion: 1 } })).ok).toBe(true);
  expect(await deps.blobStore.get({ storageKey: asset.blob.storageKey })).toEqual(bytes);
});
it('a transformer declaring a mismatched output type fails before rendition persistence', async () => {
  const deps = dependencies(); const asset = await seedAsset({ deps });
  deps.imageTransformer.transform = vi.fn().mockResolvedValue({ bytes, contentType: 'text/html' });
  const port = createJiniImageTransform({ scope: context.scope, dependencies: deps });
  expect(await port.crop({ context, request: { assetId: asset.record.id, placement: 'ad-square', presetVersion: 1 } })).toMatchObject({ ok: false, error: { code: 'invalid_input' } });
  expect(await deps.renditionRepo.findOne({ workspaceId: 'workspace', assetId: asset.record.id, transformName: 'om-ad-square-v1', version: 1 })).toBeNull();
});
