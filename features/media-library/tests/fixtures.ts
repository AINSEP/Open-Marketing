import { createHash } from 'node:crypto';
import { uploadMedia } from '@jini-ai/cms/media';
import type { CallContext } from '@open-marketing/contracts';
import type { Asset, AssetProvenance, JiniMediaDependencies, MediaLibrary, Outcome } from '../index.js';
import { createMemoryJiniDependencies, createMemoryJiniMedia, createMemoryMediaRepo, createMemoryGuardedAssetImport, createMemoryImageTransform, createMemoryBlobStore, createMemoryMediaAudit, createMediaLibrary } from '../index.js';

export const context: CallContext = { scope: { ownerId: 'owner', workspaceId: 'workspace' }, principal: { kind: 'owner', ownerId: 'owner' }, correlationId: 'correlation', traceId: 'trace' };
export const foreignContext: CallContext = { ...context, scope: { ...context.scope, workspaceId: 'foreign' } };
export const otherOwner: CallContext = { ...context, scope: { ...context.scope, ownerId: 'other' }, principal: { kind: 'owner', ownerId: 'other' } };
export const bytes = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aQx8AAAAASUVORK5CYII=', 'base64'));
export const digest = createHash('sha256').update(bytes).digest('hex');
export const clock = { now() { return 1000; } };
export const provenance: AssetProvenance = { operationId: 'operation', source: 'upload', prompt: null, model: null, seed: null, cost: null, vendorTerms: null,
  rights: { evidenceId: 'rights', license: 'owned', permittedUses: ['advertising'] } };
/** Fixture IDs are deterministic per composition and contain no hidden clock/random source. */
export function dependencies(): JiniMediaDependencies {
  let sequence = 0;
  return createMemoryJiniDependencies({ clock, ids: { next() { sequence += 1; return `asset-${sequence}`; } } });
}
/** Seed through public Jini uploadMedia, proving canonical bytes precede asset records. */
export async function seedAsset(required: { deps: JiniMediaDependencies; filename?: string }): Promise<Asset> {
  const result = await uploadMedia({ deps: required.deps, input: { workspaceId: context.scope.workspaceId, bytes: bytes.slice(), filename: required.filename ?? 'image.png', contentType: 'image/png', createdByPrincipal: 'owner' } });
  const blob = await required.deps.blobRepo.findByHash({ workspaceId: context.scope.workspaceId, sha256: result.media.source.sha256 });
  if (!blob) throw new Error('Fixture upload omitted blob');
  return { record: result.media, blob, provenance: null };
}
/** Unwrap only known-success test setup/results, preserving failure diagnostics. */
export function value<T>(required: { outcome: Outcome<T> }): T {
  if (!required.outcome.ok) throw new Error(JSON.stringify(required.outcome.error));
  return required.outcome.value;
}
export function serviceFixture(): { service: MediaLibrary; deps: JiniMediaDependencies; ports: Parameters<typeof createMediaLibrary>[0] } {
  const deps = dependencies();
  const ports = { media: createMemoryJiniMedia({ scope: context.scope, dependencies: deps }), repo: createMemoryMediaRepo({ scope: context.scope }),
    blobs: createMemoryBlobStore({ scope: context.scope }), importer: createMemoryGuardedAssetImport({ scope: context.scope }),
    transforms: createMemoryImageTransform({ scope: context.scope, dependencies: deps }), clock,
    ids: { next() { return 'unused-service-id'; } }, audit: createMemoryMediaAudit({ scope: context.scope }) };
  return { service: createMediaLibrary(ports), deps, ports };
}
