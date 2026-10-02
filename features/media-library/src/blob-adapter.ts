import { createHash } from 'node:crypto';
import { computeBlobStorageKey, withSha256Lock } from '@jini-ai/cms/media';
import type { BlobStorePort as JiniBlobStorePort } from '@jini-ai/cms/media';
import type { Scope } from '@open-marketing/contracts';
import { digestSchema } from '@open-marketing/contracts';
import type { BlobStorePort, MediaObserverPort } from './ports.js';
import { boundary } from './boundary.js';
import { checkContext, checkStorageKey, fail, success } from './validation.js';

/** Bound wrapper reuses Jini putIfAbsent; never deletes shared content on a failed/ambiguous write.
 * Host owns the injected store, filesystem root and GC authority. @complexity O(bytes), max 25 MB.
 * @example createJiniBlobStore({ scope, store: new LocalFsBlobStore({ rootDir }) })
 */
export function createJiniBlobStore(required: { scope: Scope; store: JiniBlobStorePort }, optional?: { observer?: MediaObserverPort }): BlobStorePort {
  return {
    async put(input, options) {
      const context = checkContext({ context: input.context, options, scope: required.scope });
      if (!context.ok) return context;
      const blob = input.input;
      if (blob?.workspaceId !== required.scope.workspaceId) return fail({ code: 'forbidden', message: 'Blob scope mismatch' });
      if (!digestSchema.safeParse(blob.sha256).success || !(blob.bytes instanceof Uint8Array)) return fail({ code: 'invalid_input', message: 'Invalid blob' });
      if (blob.bytes.byteLength < 1 || blob.bytes.byteLength > 25_000_000) return fail({ code: 'limit_exceeded', message: 'Blob size exceeds limit' });
      const bytes = blob.bytes.slice();
      if (createHash('sha256').update(bytes).digest('hex') !== blob.sha256) return fail({ code: 'invalid_input', message: 'Blob digest mismatch' });
      const storageKey = computeBlobStorageKey(blob);
      const key = checkStorageKey({ context: input.context, storageKey });
      if (!key.ok) return key;
      return boundary({ context: input.context, operation: 'media.blob.put', run: async () => {
        return withSha256Lock(`om-blob:${storageKey}`, async () => {
          const stored = await required.store.putIfAbsent({ ...blob, bytes });
          if (stored.storageKey !== storageKey || typeof stored.written !== 'boolean') return fail({ code: 'unavailable', message: 'Invalid blob write response' });
          const persisted = await required.store.get({ storageKey });
          if (!validBytes({ bytes: persisted, digest: blob.sha256 })) return fail({ code: 'unavailable', message: 'Blob write integrity could not be verified' });
          return success({ value: { storageKey, written: stored.written } });
        });
      } }, optional);
    },
    async read(input, options) {
      const context = checkContext({ context: input.context, options, scope: required.scope });
      if (!context.ok) return context;
      const key = checkStorageKey(input);
      if (!key.ok) return key;
      return boundary({ context: input.context, operation: 'media.blob.read', run: async () => {
        const bytes = await required.store.get({ storageKey: input.storageKey });
        if (!validBytes({ bytes, digest: input.storageKey.split('/').at(-1)! })) return fail({ code: 'unavailable', message: 'Blob read integrity failed' });
        return success({ value: bytes.slice() });
      } }, optional);
    },
    async remove(input, options) {
      const context = checkContext({ context: input.context, options, scope: required.scope });
      if (!context.ok) return context;
      const key = checkStorageKey(input);
      if (!key.ok) return key;
      return boundary({ context: input.context, operation: 'media.blob.remove', run: async () => {
        await required.store.remove({ storageKey: input.storageKey });
        return success({ value: undefined });
      } }, optional);
    },
  };
}

/** Refuse truncated or hash-mismatched content, including torn create-only writes left by upstream. @complexity O(bytes), <=25 MB. */
function validBytes(required: { bytes: Uint8Array; digest: string }): boolean {
  if (!(required.bytes instanceof Uint8Array) || required.bytes.byteLength < 1 || required.bytes.byteLength > 25_000_000) return false;
  return createHash('sha256').update(required.bytes).digest('hex') === required.digest;
}
