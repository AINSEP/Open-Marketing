import { it, expect, vi } from 'vitest';
import { MediaImportValidationError } from '@jini-ai/cms/media/import';
import { createImageInspectionAdapter, createJiniGuardedAssetImport, createJiniMediaAdapter, createMemoryImageInspection, createMediaLibrary } from '../index.js';
import { bytes, context, digest, foreignContext, provenance, serviceFixture, value } from './fixtures.js';
import { imageResponse, importFixture, sourceUrl } from './import-fixture.js';

const request = { sourceUrl, operationId: 'operation', expectedDigest: digest, provenance };

it('published ingestion attributes the canonical asset and forwards bounded correlated egress', async () => {
  const { config, requests } = importFixture(); const controller = new AbortController();
  const port = createJiniGuardedAssetImport(config, { maxBytes: 1024, timeoutMs: 4000 });
  const result = value({ outcome: await port.import({ context: { ...context, runId: 'run' }, request }, { signal: controller.signal }) });
  expect(result.record.createdBy).toBe('owner'); expect(result.provenance).toEqual(provenance);
  expect(requests).toHaveLength(1);
  expect(requests[0].request).toEqual({ method: 'GET', url: sourceUrl, maxResponseBytes: 1024, timeoutMs: 4000,
    totalDeadlineMs: 4000, signal: controller.signal, headers: { Accept: 'image/png, image/jpeg, image/webp, image/gif, image/avif',
      'x-correlation-id': 'correlation', 'x-trace-id': 'trace', 'x-run-id': 'run' } });
  expect(await config.dependencies.blobStore.get({ storageKey: result.blob.storageKey })).toEqual(bytes);
});
it('MIME comes from actual bytes, ignoring a hostile header and filename', async () => {
  const fixture = importFixture(); fixture.reply({ response: { ...imageResponse, headers: { 'content-type': 'text/html' }, finalUrl: 'https://example.com/page.html' } });
  const imported = value({ outcome: await fixture.port.import({ context, request }) });
  expect(imported.record.title).toBe('page');
  expect(await fixture.config.dependencies.blobStore.get({ storageKey: imported.blob.storageKey })).toEqual(bytes);
});
it('rejects oversized, missing, truncated and HTML bytes before any canonical publication', async () => {
  const responses = [
    { ...imageResponse, bodyBytes: undefined }, { ...imageResponse, bodyBytesTruncated: true },
    { ...imageResponse, bodyBytes: Uint8Array.from(Buffer.from('<html>not an image</html>')), headers: { 'content-type': 'image/png' } },
  ];
  for (const response of responses) {
    const fixture = importFixture(); fixture.reply({ response });
    expect(await fixture.port.import({ context, request })).toMatchObject({ ok: false, error: { code: 'invalid_input' } });
    expect(await fixture.config.dependencies.mediaRepo.list({ workspaceId: 'workspace' })).toEqual([]);
    expect(await fixture.config.dependencies.blobRepo.list({ workspaceId: 'workspace' })).toEqual([]);
  }
  const fixture = importFixture(); const port = createJiniGuardedAssetImport(fixture.config, { maxBytes: bytes.byteLength - 1 });
  expect(await port.import({ context, request })).toMatchObject({ ok: false, error: { code: 'invalid_input' } });
  expect(await fixture.config.dependencies.blobStore.exists({ storageKey: `ws/workspace/blobs/${digest.slice(0, 2)}/${digest}` })).toBe(false);
});
it('precise byte completeness accepts intact binary despite clipped unused text', async () => {
  const fixture = importFixture(); fixture.reply({ response: { ...imageResponse, bodyTruncated: true, bodyBytesTruncated: false } });
  expect((await fixture.port.import({ context, request })).ok).toBe(true);
});
it('a guard refusal or unfollowed redirect cannot publish records or bypass the guard', async () => {
  const fixture = importFixture();
  const send = vi.fn().mockRejectedValue(new MediaImportValidationError({ message: 'Redirect destination rejected' }));
  const port = createJiniGuardedAssetImport({ ...fixture.config, outboundGuard: { send } });
  expect(await port.import({ context, request })).toMatchObject({ ok: false, error: { code: 'invalid_input' } });
  expect(send).toHaveBeenCalledTimes(1);
  expect(await fixture.config.dependencies.mediaRepo.list({ workspaceId: 'workspace' })).toEqual([]);
  fixture.reply({ response: { ...imageResponse, status: 302, headers: { location: 'http://169.254.169.254/' } } });
  expect(await fixture.port.import({ context, request })).toMatchObject({ ok: false, error: { code: 'invalid_input' } });
  expect(fixture.requests).toHaveLength(1);
  expect(await fixture.config.dependencies.blobRepo.list({ workspaceId: 'workspace' })).toEqual([]);
});
it('tainted replies and invalid final URLs fail closed', async () => {
  for (const response of [{ ...imageResponse, status: NaN }, { ...imageResponse, finalUrl: 'https://user:secret@example.com/image.png' }]) {
    const fixture = importFixture(); fixture.reply({ response });
    expect((await fixture.port.import({ context, request })).ok).toBe(false);
    expect(await fixture.config.dependencies.mediaRepo.list({ workspaceId: 'workspace' })).toEqual([]);
  }
});
it('decoded edge and animation limits apply before byte storage', async () => {
  for (const image of [{ width: 8001, height: 1, frames: 1 }, { width: 1, height: 1, frames: 2 }]) {
    const fixture = importFixture();
    const inspection = createMemoryImageInspection({ scope: context.scope, fixtures: [{ bytes, contentType: 'image/png', image }] });
    const port = createJiniGuardedAssetImport({ ...fixture.config, inspection });
    expect(await port.import({ context, request })).toMatchObject({ ok: false, error: { code: 'limit_exceeded' } });
    expect(await fixture.config.dependencies.blobRepo.list({ workspaceId: 'workspace' })).toEqual([]);
  }
});
it('abort during decode prevents publication and decoder mutation cannot change imported bytes', async () => {
  const fixture = importFixture(); const controller = new AbortController();
  const inspection = createImageInspectionAdapter({ scope: context.scope, async decode(input) {
    input.bytes.fill(0); controller.abort(); return { width: 1, height: 1, frames: 1 };
  } });
  const port = createJiniGuardedAssetImport({ ...fixture.config, inspection });
  expect(await port.import({ context, request }, { signal: controller.signal })).toMatchObject({ ok: false, error: { code: 'cancelled' } });
  expect(await fixture.config.dependencies.mediaRepo.list({ workspaceId: 'workspace' })).toEqual([]);
  expect(value({ outcome: await fixture.port.import({ context, request }) }).blob.sha256).toBe(digest);
});
it('foreign contexts, invalid bounds and pre-aborted requests never reach egress', async () => {
  const fixture = importFixture(); const controller = new AbortController(); controller.abort();
  expect(await fixture.port.import({ context: foreignContext, request })).toMatchObject({ ok: false, error: { code: 'forbidden' } });
  expect(await fixture.port.import({ context, request }, { signal: controller.signal })).toMatchObject({ ok: false, error: { code: 'cancelled' } });
  const invalid = createJiniGuardedAssetImport(fixture.config, { imageLimits: { maxEdge: 9000, maxPixels: 1000, maxFrames: 1 } });
  expect(await invalid.import({ context, request })).toMatchObject({ ok: false, error: { code: 'invalid_input' } });
  expect(fixture.requests).toEqual([]);
});
it('failure after rendition save rolls back only the new media rows and tombstones unreferenced content', async () => {
  const fixture = importFixture(); const deps = fixture.config.dependencies;
  const save = deps.renditionRepo.save.bind(deps.renditionRepo);
  deps.renditionRepo.save = async record => { await save(record); throw new Error('Ambiguous rendition publication'); };
  expect(await fixture.port.import({ context, request })).toMatchObject({ ok: false, error: { code: 'unavailable' } });
  expect(await deps.mediaRepo.list({ workspaceId: 'workspace' })).toEqual([]);
  const blob = await deps.blobRepo.findByHash({ workspaceId: 'workspace', sha256: digest });
  expect(blob?.status).toBe('tombstoned'); expect(await deps.blobStore.get({ storageKey: blob!.storageKey })).toEqual(bytes);
  deps.renditionRepo.save = save;
  const imported = value({ outcome: await fixture.port.import({ context, request }) });
  expect(await deps.renditionRepo.listByAsset({ workspaceId: 'workspace', assetId: imported.record.id })).toHaveLength(1);
  expect(await deps.mediaRepo.list({ workspaceId: 'workspace' })).toEqual([imported.record]);
});
it('failure during blob-row publication tombstones the new row without deleting content', async () => {
  const fixture = importFixture(); const repo = fixture.config.dependencies.blobRepo; const save = repo.save.bind(repo);
  let firstSave = true;
  repo.save = async record => { await save(record); if (firstSave) { firstSave = false; throw new Error('Blob row committed then failed'); } };
  expect(await fixture.port.import({ context, request })).toMatchObject({ ok: false, error: { code: 'unavailable' } });
  expect(await repo.findByHash({ workspaceId: 'workspace', sha256: digest })).toMatchObject({ status: 'tombstoned' });
  expect(await fixture.config.dependencies.mediaRepo.list({ workspaceId: 'workspace' })).toEqual([]);
});
it('service evidence survives rejected ingress and later successful association', async () => {
  const fixture = importFixture(); const { ports } = serviceFixture();
  const service = createMediaLibrary({ ...ports, importer: fixture.port,
    media: createJiniMediaAdapter({ scope: context.scope, dependencies: fixture.config.dependencies }) });
  fixture.reply({ response: { ...imageResponse, bodyBytesTruncated: true } });
  expect((await service.importAsset({ context, request })).ok).toBe(false);
  expect(value({ outcome: await ports.repo.evidence({ context, operationId: 'operation' }) }).provenance).toEqual([{ provenance }]);
  fixture.reply({ response: imageResponse });
  const asset = value({ outcome: await service.importAsset({ context, request }) });
  expect(value({ outcome: await ports.repo.evidence({ context, operationId: 'operation' }) }).provenance).toEqual([{ provenance, assetId: asset.record.id }]);
});
