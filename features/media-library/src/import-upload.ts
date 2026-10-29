import { rollbackUploadedMedia, tombstoneBlobIfUnreferenced, uploadMedia } from '@jini-ai/cms/media';
import type { AssetBlobRecord, AssetBlobRepoPort, BlobStorePort as JiniBlobStorePort, MediaRecord, MediaRepoPort as JiniMediaRepoPort } from '@jini-ai/cms/media';
import type { CallContext, CallOptions, Outcome, ObserverPort } from '@open-marketing/contracts';
import type { Asset } from './types.js';
import type { JiniMediaDependencies } from './ports.js';
import { boundary, MediaBoundaryFailure } from './boundary.js';
import { createJiniBlobStore } from './blob-adapter.js';
import { createJiniMediaAdapter } from './jini-media.js';
import { blobSchema, checkContext, fail, recordSchema, success } from './validation.js';

type Upload = { context: CallContext; deps: JiniMediaDependencies; bytes: Uint8Array; contentType: string; filename: string; options?: CallOptions };
type Attempt = { media?: MediaRecord; blob?: AssetBlobRecord };

/** Delegate canonical records to Jini. Track only this attempt's new media row for upstream rollback.
 * Whole-byte create-only storage avoids Jini upload's overwrite-capable put; bytes are never deleted here.
 * Failure before blob-row publication may leave orphan bytes: host reconciliation is still required.
 * @complexity O(bytes) upload; compensation inherits Jini's O(workspace assets) reference scan.
 */
export async function uploadCanonical(required: Upload, optional?: { observer?: ObserverPort }): Promise<Outcome<Asset>> {
  const attempt: Attempt = {};
  const deps = { ...required.deps, mediaRepo: trackedMediaRepo({ ...required, attempt }), blobRepo: trackedBlobRepo({ ...required, attempt }), blobStore: createOnlyStore(required, optional) };
  try {
    const uploaded = await uploadMedia({ deps, input: { workspaceId: required.context.scope.workspaceId,
      bytes: required.bytes.slice(), contentType: required.contentType, filename: required.filename,
      createdByPrincipal: principalReference(required) } }, { maxUploadBytes: 25_000_000, allowedMimeTypes: new Set([required.contentType]) });
    const media = createJiniMediaAdapter({ scope: required.context.scope, dependencies: required.deps });
    const asset = await media.get({ context: required.context, assetId: uploaded.media.id }, required.options);
    if (!asset.ok) throw new MediaBoundaryFailure({ error: asset.error });
    if (asset.value.blob.sha256 !== uploaded.media.source.sha256) throw new MediaBoundaryFailure({ error: { code: 'conflict', message: 'Uploaded canonical digest changed', retryable: false } });
    return asset;
  } catch (error) {
    const cleanup = await boundary({ context: required.context, operation: 'media.import.cleanup', run: async () => {
      if (attempt.media) await rollbackUploadedMedia({ deps: required.deps, input: { workspaceId: required.context.scope.workspaceId, media: attempt.media } });
      if (attempt.blob) await tombstoneBlobIfUnreferenced({ deps: required.deps, input: { workspaceId: required.context.scope.workspaceId, sha256: attempt.blob.sha256 } });
      return success({ value: undefined });
    } }, optional);
    if (!cleanup.ok) return fail({ code: 'unavailable', message: 'Import cleanup incomplete; reconcile before retrying' });
    throw error;
  }
}

/** Foreign repo ABI is forwarded explicitly (class methods are on the prototype, not spreadable).
 * Scope/ID checks prevent compensation from removing a known pre-existing asset. @complexity O(1) per save.
 */
function trackedMediaRepo(required: Upload & { attempt: Attempt }): JiniMediaRepoPort {
  const repo = required.deps.mediaRepo;
  return {
    findById: input => repo.findById(input), findBySlug: input => repo.findBySlug(input), list: input => repo.list(input), remove: input => repo.remove(input),
    async save(record) {
      const parsed = recordSchema.safeParse(record);
      if (!parsed.success) throw new MediaBoundaryFailure({ error: { code: 'unavailable', message: 'Invalid canonical upload record', retryable: false } });
      if (parsed.data.workspaceId !== required.context.scope.workspaceId) throw new MediaBoundaryFailure({ error: { code: 'forbidden', message: 'Upload scope mismatch', retryable: false } });
      const context = checkContext({ context: required.context, options: required.options });
      if (!context.ok) throw new MediaBoundaryFailure({ error: context.error });
      if (await repo.findById({ workspaceId: record.workspaceId, id: record.id })) throw new MediaBoundaryFailure({ error: { code: 'conflict', message: 'Upload ID already exists', retryable: false } });
      required.attempt.media = parsed.data;
      await repo.save(parsed.data);
    },
  };
}

/** Track new blob rows before a possibly ambiguous save. Cleanup only tombstones after Jini rechecks references.
 * No digest-addressed bytes are removed; shared/referenced blobs are retained. @complexity O(1) per save.
 */
function trackedBlobRepo(required: Upload & { attempt: Attempt }): AssetBlobRepoPort {
  const repo = required.deps.blobRepo;
  return {
    findByHash: input => repo.findByHash(input), list: input => repo.list(input), remove: input => repo.remove(input),
    async save(blob) {
      const parsed = blobSchema.safeParse(blob);
      if (!parsed.success || parsed.data.workspaceId !== required.context.scope.workspaceId) throw new MediaBoundaryFailure({ error: { code: 'unavailable', message: 'Invalid canonical upload blob', retryable: false } });
      const previous = await repo.findByHash({ workspaceId: blob.workspaceId, sha256: blob.sha256 });
      if (!previous) required.attempt.blob = parsed.data;
      await repo.save(parsed.data);
    },
  };
}

/** Jini's upload ABI throws on write failure; the owned byte port's explicit refusal survives unchanged.
 * A failed blob-row save leaves whole bytes for reconciliation, never an unsafe deletion of shared content.
 */
function createOnlyStore(required: Upload, optional?: { observer?: ObserverPort }): JiniBlobStorePort {
  const store = required.deps.blobStore;
  const port = createJiniBlobStore({ scope: required.context.scope, store }, optional);
  return {
    get: input => store.get(input), exists: input => store.exists(input), remove: input => store.remove(input),
    putIfAbsent: input => store.putIfAbsent(input),
    async put(input) {
      const stored = await port.put({ context: required.context, input }, required.options);
      if (!stored.ok) throw new MediaBoundaryFailure({ error: stored.error });
      return { storageKey: stored.value.storageKey };
    },
  };
}
function principalReference(required: { context: CallContext }): string {
  const { principal } = required.context;
  switch (principal.kind) {
    case 'owner': return principal.ownerId;
    case 'agent': return principal.agentInstanceId;
    case 'service': return principal.serviceId;
    default: { const unhandled: never = principal; throw new Error(String(unhandled)); }
  }
}
