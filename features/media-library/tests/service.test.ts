import { it, expect, vi } from 'vitest';
import { createJiniMediaAdapter, createMediaLibrary, createMemoryMediaObserver } from '../index.js';
import { bytes, context, foreignContext, otherOwner, digest, provenance, seedAsset, serviceFixture, value } from './fixtures.js';

it('factory is inert and accesses no ports until a call', () => {
  const dependencies = new Proxy({} as Parameters<typeof createMediaLibrary>[0], { get() { throw new Error('Factory accessed a dependency'); } });
  expect(createMediaLibrary(dependencies)).toHaveProperty('createCrop');
});
it('retains provenance and cost when URL import is unavailable', async () => {
  const { service, ports } = serviceFixture();
  const cost = { observationId: 'estimated', operationId: 'operation', kind: 'estimated' as const, amount: { currency: 'USD', minorUnits: 20 } };
  expect(await service.recordCost({ context, cost })).toEqual({ ok: true, value: undefined });
  expect(await service.importAsset({ context, request: { sourceUrl: 'https://example.com/image.png', operationId: 'operation', expectedDigest: digest, provenance } })).toMatchObject({ ok: false, error: { code: 'not_implemented' } });
  expect(value({ outcome: await ports.repo.evidence({ context, operationId: 'operation' }) })).toEqual({ provenance: [{ provenance }], costs: [cost] });
});
it('deduplicated known imports preserve provenance from every operation without fetching', async () => {
  const { deps, ports } = serviceFixture();
  const asset = await seedAsset({ deps });
  ports.importer.import = vi.fn().mockRejectedValue(new Error('Known content should not be fetched'));
  const service = createMediaLibrary(ports);
  for (const operationId of ['first', 'second', 'first']) {
    const evidence = { ...provenance, operationId, prompt: operationId };
    const result = value({ outcome: await service.importAsset({ context, request: { sourceUrl: 'https://example.com/image.png', operationId, expectedDigest: digest, provenance: evidence } }) });
    expect(result.record.id).toBe(asset.record.id); expect(result.provenance).toEqual(evidence);
  }
  expect(ports.importer.import).not.toHaveBeenCalled();
  const first = value({ outcome: await ports.repo.evidence({ context, operationId: 'first' }) });
  const second = value({ outcome: await ports.repo.evidence({ context, operationId: 'second' }) });
  expect(first.provenance).toHaveLength(1); expect(second.provenance).toHaveLength(1);
  expect(first.provenance[0].assetId).toBe(second.provenance[0].assetId);
});
it('creates a stable non-destructive crop with accessible original bytes', async () => {
  const { service, deps } = serviceFixture(); const original = await seedAsset({ deps });
  const input = { context, request: { assetId: original.record.id, placement: 'ad-story', presetVersion: 1 } };
  const first = value({ outcome: await service.createCrop(input) });
  expect(value({ outcome: await service.createCrop(input) })).toEqual(first);
  expect(first.rendition.storageKey).not.toBe(original.blob.storageKey);
  expect(await deps.blobStore.exists({ storageKey: original.blob.storageKey })).toBe(true);
  expect(await service.createCrop({ ...input, context: foreignContext })).toMatchObject({ ok: false, error: { code: 'forbidden' } });
});
it('rejects malformed input before any port or irreversible effect', async () => {
  const dependencies = new Proxy({} as Parameters<typeof createMediaLibrary>[0], { get() { throw new Error('Invalid input reached a dependency'); } });
  const service = createMediaLibrary(dependencies);
  expect(await service.recordProvenance({ context, link: { provenance: { ...provenance, rights: { ...provenance.rights, license: '' } } } })).toMatchObject({ ok: false, error: { code: 'invalid_input' } });
  expect(await service.createCrop({ context, request: { assetId: 'asset', placement: 'ad-square', presetVersion: 0 } })).toMatchObject({ ok: false, error: { code: 'invalid_input' } });
  expect(await service.list({ context, query: { limit: 101 } })).toMatchObject({ ok: false, error: { code: 'invalid_input' } });
  expect(await service.recordCost({ context, cost: { observationId: 'cost', operationId: 'operation', amount: { currency: 'USD', minorUnits: 1 }, kind: 'correction' } })).toMatchObject({ ok: false, error: { code: 'invalid_input' } });
});
it('partial import failure retains evidence', async () => {
  const { ports } = serviceFixture();
  ports.importer.import = vi.fn().mockResolvedValue({ ok: false, error: { code: 'unavailable', message: 'partial failure', retryable: false } });
  const service = createMediaLibrary(ports);
  expect(await service.importAsset({ context, request: { sourceUrl: 'https://example.com/image.png', operationId: 'operation', expectedDigest: digest, provenance } })).toMatchObject({ ok: false, error: { code: 'unavailable' } });
  expect(value({ outcome: await ports.repo.evidence({ context, operationId: 'operation' }) }).provenance).toEqual([{ provenance }]);
});
it('audit failure is explicit and a retry keeps the same canonical binding', async () => {
  const { ports, deps } = serviceFixture(); const asset = await seedAsset({ deps });
  const record = ports.audit.record;
  ports.audit.record = vi.fn().mockResolvedValueOnce({ ok: false, error: { code: 'unavailable', message: 'audit failed', retryable: false } }).mockImplementation(record);
  const service = createMediaLibrary(ports);
  const input = { context, request: { sourceUrl: 'https://example.com/image.png', operationId: 'operation', expectedDigest: digest, provenance } };
  expect(await service.importAsset(input)).toMatchObject({ ok: false, error: { code: 'unavailable' } });
  expect(value({ outcome: await service.importAsset(input) }).record.id).toBe(asset.record.id);
  expect(value({ outcome: await ports.repo.evidence({ context, operationId: 'operation' }) }).provenance).toHaveLength(1);
});
it('observes outcome/correlation and contains throwing telemetry', async () => {
  const { ports } = serviceFixture(); const observer = createMemoryMediaObserver({});
  const service = createMediaLibrary(ports, { observer });
  await service.list({ context: { ...context, runId: 'run' }, query: { limit: 1 } });
  expect(observer.events({})).toEqual([{ operation: 'media.list', outcome: 'ok', correlationId: 'correlation', traceId: 'trace', runId: 'run' }]);
  const throwing = createMediaLibrary(ports, { observer: { observe() { throw new Error('Telemetry failed'); } } });
  expect(await throwing.recordProvenance({ context, link: { provenance } })).toEqual({ ok: true, value: undefined });
});
it('dependency exceptions become explicit unavailable outcomes with no driver details', async () => {
  const { ports } = serviceFixture(); ports.media.list = vi.fn().mockRejectedValue(new Error('secret driver information'));
  const result = await createMediaLibrary(ports).list({ context, query: { limit: 1 } });
  expect(result).toMatchObject({ ok: false, error: { code: 'unavailable', retryable: false } });
  expect(JSON.stringify(result)).not.toContain('secret');
});

it.each(['adapter', 'memory'] as const)('reads only active scoped images within the requested bound / %s', async adapter => {
  const { ports, deps } = serviceFixture();
  const service = createMediaLibrary({ ...ports, media: adapter === 'adapter' ? createJiniMediaAdapter({ scope: context.scope, dependencies: deps }) : ports.media });
  const asset = await seedAsset({ deps });
  expect(value({ outcome: await service.readImage({ context, assetId: asset.record.id, maxBytes: 1048576 }) })).toEqual({ asset, bytes });
  for (const denied of [foreignContext, otherOwner]) {
    expect(await service.readImage({ context: denied, assetId: asset.record.id, maxBytes: 1048576 })).toMatchObject({ ok: false, error: { code: 'forbidden' } });
  }
  expect(await service.readImage({ context, assetId: asset.record.id, maxBytes: bytes.length - 1 })).toMatchObject({ ok: false, error: { code: 'limit_exceeded' } });
  expect((await service.readImage({ context, assetId: 'missing', maxBytes: 1048576 })).ok).toBe(false);
  await deps.mediaRepo.save({ ...asset.record, status: 'trashed' });
  expect((await service.readImage({ context, assetId: asset.record.id, maxBytes: 1048576 })).ok).toBe(false);
});
it('uploadImage delegates admitted bytes to the canonical importer and observes no filenames', async () => {
  const { ports, deps } = serviceFixture();
  const asset = await seedAsset({ deps });
  const observer = createMemoryMediaObserver({});
  ports.importer.upload = vi.fn().mockResolvedValue({ ok: true, value: asset });
  const service = createMediaLibrary(ports, { observer });
  const input = { context, bytes, filename: 'private-name.png', contentTypes: ['image/png'] };
  expect(await service.uploadImage(input)).toEqual({ ok: true, value: asset });
  expect(ports.importer.upload).toHaveBeenCalledWith(input, undefined);
  expect(JSON.stringify(observer.events({}))).not.toContain('private-name');
});
