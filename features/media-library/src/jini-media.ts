import { getMediaById, listMedia, parseMediaHtmlAttributes } from '@jini-ai/cms/media';
import type { MediaRecord } from '@jini-ai/cms/media';
import { digestSchema, idSchema, parseBoundary } from '@open-marketing/contracts';
import type { CallContext, Outcome, Scope } from '@open-marketing/contracts';
import type { Asset, AssetPage, AssetQuery } from './types.js';
import type { JiniMediaDependencies, JiniMediaPort, MediaObserverPort } from './ports.js';
import { boundary } from './boundary.js';
import { assetSchema, blobSchema, checkContext, fail, querySchema, recordSchema, success } from './validation.js';

/** Scoped Outcome wrapper over public Jini repositories/services; marketing evidence remains in MediaRepoPort.
 * save registers an already-ingested canonical asset and refuses replacement. It never uploads arbitrary bytes.
 * @complexity O(n log n) listing, bounded to 1,000 loaded records (Jini currently materializes upstream list).
 * @example createJiniMediaAdapter({ scope, dependencies })
 */
export function createJiniMediaAdapter(required: { scope: Scope; dependencies: JiniMediaDependencies }, optional?: { observer?: MediaObserverPort }): JiniMediaPort {
  const { dependencies: deps } = required;
  return {
    async save(input, options) {
      const context = checkContext({ context: input.context, options, scope: required.scope });
      if (!context.ok) return context;
      const asset = parseBoundary({ schema: assetSchema, input: input.asset });
      if (!asset.ok) return asset;
      if (asset.value.record.workspaceId !== required.scope.workspaceId) return fail({ code: 'forbidden', message: 'Asset scope mismatch' });
      return boundary({ context: input.context, operation: 'media.canonical.save', run: async () => saveCanonical({ deps, asset: asset.value }) }, optional);
    },
    async get(input, options) {
      const context = checkContext({ context: input.context, options, scope: required.scope });
      if (!context.ok) return context;
      if (!idSchema.safeParse(input.assetId).success) return fail({ code: 'invalid_input', message: 'Invalid asset ID' });
      return boundary({ context: input.context, operation: 'media.canonical.get', run: async () => {
        const result = await getMediaById({ deps, input: { workspaceId: required.scope.workspaceId, id: input.assetId } });
        if (result.media.id !== input.assetId) return fail({ code: 'unavailable', message: 'Canonical identity mismatch' });
        return projectAsset({ deps, record: result.media, scope: required.scope });
      } }, optional);
    },
    async findByDigest(input, options) {
      const context = checkContext({ context: input.context, options, scope: required.scope });
      if (!context.ok) return context;
      if (!digestSchema.safeParse(input.contentDigest).success) return fail({ code: 'invalid_input', message: 'Invalid digest' });
      return boundary({ context: input.context, operation: 'media.canonical.findByDigest', run: async () => {
        const records = await loadRecords({ deps, scope: required.scope });
        if (!records.ok) return records;
        const record = records.value.find(item => item.source.sha256 === input.contentDigest && item.status === 'active');
        if (!record) return success({ value: null });
        return projectAsset({ deps, record, scope: required.scope });
      } }, optional);
    },
    async list(input, options) {
      const context = checkContext({ context: input.context, options, scope: required.scope });
      if (!context.ok) return context;
      const query = parseBoundary({ schema: querySchema, input: input.query });
      if (!query.ok) return query;
      return boundary({ context: input.context, operation: 'media.canonical.list', run: async () => listPage({ deps, scope: required.scope, query: query.value }) }, optional);
    },
  };
}
/** Save is immutable and requires source bytes. Evidence is not stored in Jini record rows. @complexity O(1) calls. */
async function saveCanonical(required: { deps: JiniMediaDependencies; asset: Asset }): Promise<Outcome<Asset>> {
  const { deps, asset } = required;
  if (asset.record.htmlAttributes && parseMediaHtmlAttributes({ text: asset.record.htmlAttributes }).error !== null) return fail({ code: 'invalid_input', message: 'Unsafe media attributes' });
  if (!await deps.blobStore.exists({ storageKey: asset.blob.storageKey })) return fail({ code: 'unavailable', message: 'Canonical source bytes are absent' });
  const previous = await deps.mediaRepo.findById({ workspaceId: asset.record.workspaceId, id: asset.record.id });
  if (previous && JSON.stringify(recordSchema.parse(previous)) !== JSON.stringify(asset.record)) return fail({ code: 'conflict', message: 'Canonical record is immutable' });
  const blob = await deps.blobRepo.findByHash({ workspaceId: asset.blob.workspaceId, sha256: asset.blob.sha256 });
  if (blob && JSON.stringify(blobSchema.parse(blob)) !== JSON.stringify(asset.blob)) return fail({ code: 'conflict', message: 'Canonical blob conflict' });
  if (!blob) await deps.blobRepo.save(structuredClone(asset.blob));
  if (!previous) await deps.mediaRepo.save(structuredClone(asset.record));
  return success({ value: structuredClone(asset) });
}
/** Parse upstream records and cap work before sorting/projecting. @complexity O(n log n); upstream list remains unpaginated. */
async function loadRecords(required: { deps: JiniMediaDependencies; scope: Scope }): Promise<Outcome<MediaRecord[]>> {
  const result = await listMedia({ deps: required.deps, input: { workspaceId: required.scope.workspaceId } });
  if (!Array.isArray(result.media)) return fail({ code: 'unavailable', message: 'Invalid canonical list' });
  if (result.media.length > 1000) return fail({ code: 'limit_exceeded', message: 'Canonical list exceeds 1,000 records' });
  const records = recordSchema.array().safeParse(result.media);
  if (!records.success) return fail({ code: 'unavailable', message: 'Invalid canonical records' });
  if (records.data.some(record => record.workspaceId !== required.scope.workspaceId)) return fail({ code: 'forbidden', message: 'Canonical scope mismatch' });
  records.data.sort((left, right) => left.id.localeCompare(right.id, 'en'));
  return success({ value: records.data });
}
/** Assemble from canonical Jini records without introducing an OM asset store. @complexity O(1). */
async function projectAsset(required: { deps: JiniMediaDependencies; record: MediaRecord; scope: Scope }): Promise<Outcome<Asset>> {
  if (required.record.workspaceId !== required.scope.workspaceId) return fail({ code: 'forbidden', message: 'Canonical scope mismatch' });
  const blob = await required.deps.blobRepo.findByHash({ workspaceId: required.scope.workspaceId, sha256: required.record.source.sha256 });
  const asset = assetSchema.safeParse({ record: required.record, blob, provenance: null });
  if (!asset.success) return fail({ code: 'unavailable', message: 'Invalid canonical asset' });
  return success({ value: asset.data });
}
/** Stable ID keyset pages; inaccessible/invalid cursor IDs fail closed. @complexity O(n + limit) beyond upstream sorting. */
async function listPage(required: { deps: JiniMediaDependencies; scope: Scope; query: AssetQuery }): Promise<Outcome<AssetPage>> {
  const records = await loadRecords(required);
  if (!records.ok) return records;
  const active = records.value.filter(record => record.status === 'active');
  let offset = 0;
  if (required.query.cursor) {
    const index = active.findIndex(record => record.id === required.query.cursor);
    if (index < 0) return fail({ code: 'forbidden', message: 'Cursor is absent or inaccessible' });
    offset = index + 1;
  }
  const selected = active.slice(offset, offset + required.query.limit);
  const items: Asset[] = [];
  for (const record of selected) {
    const asset = await projectAsset({ deps: required.deps, scope: required.scope, record });
    if (!asset.ok) return asset;
    items.push(asset.value);
  }
  const hasMore = offset + selected.length < active.length;
  return success({ value: { items, cursor: hasMore ? selected[selected.length - 1].id : null } });
}
