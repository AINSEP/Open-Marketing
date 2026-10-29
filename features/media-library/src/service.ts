import { parseBoundary } from '@open-marketing/contracts';
import type { CallContext, CallOptions, Outcome, ObserverPort } from '@open-marketing/contracts';
import type { Asset, AssetImportRequest, MediaLibrary, PlacementCrop, PlacementCropPreset, PlacementCropRequest } from './types.js';
import type { MediaRepoPort, JiniMediaPort, GuardedAssetImportPort, ImageTransformPort, MediaAuditPort } from './ports.js';
import { boundary } from './boundary.js';
import { assetSchema, checkContext, costSchema, cropRequestSchema, cropSchema, fail, importSchema, linkSchema, querySchema, success } from './validation.js';
import { selectPreset } from './rules.js';
import { PLACEMENT_CROP_PRESETS } from './presets.js';

type Dependencies = { repo: MediaRepoPort; media: JiniMediaPort; importer: GuardedAssetImportPort;
  transforms: ImageTransformPort; audit: MediaAuditPort };
/** Inert OM marketing orchestration with caller-owned effects. Every call validates before effects.
 * Import records evidence first, then canonical registration/association/audit; failed stages remain explicit and resumable.
 * Source blobs belong to Jini: this service never deletes them during error compensation.
 * @complexity O(1) calls per write; list inherits adapter bounds. @example createMediaLibrary({ repo, media, importer, transforms, audit })
 */
export function createMediaLibrary(required: Dependencies, optional?: { observer?: ObserverPort; placementPresets?: readonly PlacementCropPreset[] }): MediaLibrary {
  return {
    async uploadImage(input, options) {
      const context = checkContext({ context: input.context, options });
      if (!context.ok) return context;
      return boundary({ context: input.context, operation: 'media.uploadImage', run: () => required.importer.upload(input, options) }, optional);
    },
    async readImage(input, options) {
      const context = checkContext({ context: input.context, options });
      if (!context.ok) return context;
      return boundary({ context: input.context, operation: 'media.readImage', run: () => required.media.read(input, options) }, optional);
    },
    async importAsset(input, options) {
      const context = checkContext({ context: input.context, options });
      if (!context.ok) return context;
      const request = parseBoundary({ schema: importSchema, input: input.request });
      if (!request.ok) return request;
      return boundary({ context: input.context, operation: 'media.importAsset', run: async () => importAsset({ deps: required, context: input.context, request: request.value, options }) }, optional);
    },
    async createCrop(input, options) {
      const context = checkContext({ context: input.context, options });
      if (!context.ok) return context;
      const request = parseBoundary({ schema: cropRequestSchema, input: input.request });
      if (!request.ok) return request;
      const preset = selectPreset({ presets: optional?.placementPresets ?? PLACEMENT_CROP_PRESETS, request: request.value });
      if (!preset.ok) return preset;
      return boundary({ context: input.context, operation: 'media.createCrop', run: async () => createCrop({ deps: required, context: input.context, request: request.value, options }) }, optional);
    },
    async list(input, options) {
      const context = checkContext({ context: input.context, options });
      if (!context.ok) return context;
      const query = parseBoundary({ schema: querySchema, input: input.query });
      if (!query.ok) return query;
      return boundary({ context: input.context, operation: 'media.list', run: async () => required.media.list({ context: input.context, query: query.value }, options) }, optional);
    },
    async recordProvenance(input, options) {
      const context = checkContext({ context: input.context, options });
      if (!context.ok) return context;
      const link = parseBoundary({ schema: linkSchema, input: input.link });
      if (!link.ok) return link;
      return boundary({ context: input.context, operation: 'media.recordProvenance', run: async () => {
        if (link.value.assetId) {
          const asset = await required.media.get({ context: input.context, assetId: link.value.assetId }, options);
          if (!asset.ok) return asset;
        }
        return required.repo.appendProvenance({ context: input.context, link: link.value }, options);
      } }, optional);
    },
    async recordCost(input, options) {
      const context = checkContext({ context: input.context, options });
      if (!context.ok) return context;
      const cost = parseBoundary({ schema: costSchema, input: input.cost });
      if (!cost.ok) return cost;
      return boundary({ context: input.context, operation: 'media.recordCost', run: async () => required.repo.appendCost({ context: input.context, cost: cost.value }, options) }, optional);
    },
  };
}
/** Dedupe by canonical digest while preserving each operation's immutable evidence. No retry loop or blob deletion. @complexity O(1) port calls. */
async function importAsset(required: { deps: Dependencies; context: CallContext; request: AssetImportRequest; options?: CallOptions }): Promise<Outcome<Asset>> {
  const { deps, context, request, options } = required;
  const evidence = await deps.repo.appendProvenance({ context, link: { provenance: request.provenance } }, options);
  if (!evidence.ok) return evidence;
  const existing = await deps.media.findByDigest({ context, contentDigest: request.expectedDigest }, options);
  if (!existing.ok) return existing;
  const canonical = await importCanonical({ ...required, existing: existing.value });
  if (!canonical.ok) return canonical;
  const validated = validateImport({ asset: canonical.value, context, request });
  if (!validated.ok) return validated;
  const linked = await deps.repo.appendProvenance({ context, link: { provenance: request.provenance, assetId: validated.value.record.id } }, options);
  if (!linked.ok) return linked;
  const audit = await deps.audit.record({ context, operationId: request.operationId, assetId: validated.value.record.id }, options);
  if (!audit.ok) return audit;
  return success({ value: { ...validated.value, provenance: request.provenance } });
}
/** Validate a new importer result before canonical storage; failures leave provenance resumable.
 * @complexity O(1) port calls; no retries or compensation writes.
 */
async function importCanonical(required: { deps: Dependencies; context: CallContext; request: AssetImportRequest; existing: Asset | null; options?: CallOptions }): Promise<Outcome<Asset>> {
  const { deps, context, request, options } = required;
  if (required.existing) return success({ value: required.existing });
  const imported = await deps.importer.import({ context, request }, options);
  if (!imported.ok) return imported;
  const checked = validateImport({ asset: imported.value, context, request });
  if (!checked.ok) return checked;
  return deps.media.save({ context, asset: checked.value }, options);
}
/** Tainted importer output cannot bind another workspace or different content to this operation. @complexity O(1), bounded schema. */
function validateImport(required: { asset: Asset; context: CallContext; request: AssetImportRequest }): Outcome<Asset> {
  const asset = assetSchema.safeParse(required.asset);
  if (!asset.success) return fail({ code: 'unavailable', message: 'Invalid canonical import output' });
  if (asset.data.record.workspaceId !== required.context.scope.workspaceId) return fail({ code: 'forbidden', message: 'Import scope mismatch' });
  if (asset.data.blob.sha256 !== required.request.expectedDigest) return fail({ code: 'conflict', message: 'Import digest mismatch' });
  return success({ value: asset.data });
}
/** Persist only a rendition linked to an accessible original and the exact requested preset. @complexity O(1) calls. */
async function createCrop(required: { deps: Dependencies; context: CallContext; request: PlacementCropRequest; options?: CallOptions }): Promise<Outcome<PlacementCrop>> {
  const { deps, context, request, options } = required;
  const original = await deps.media.get({ context, assetId: request.assetId }, options);
  if (!original.ok) return original;
  if (original.value.record.workspaceId !== context.scope.workspaceId || original.value.record.status !== 'active') return fail({ code: 'forbidden', message: 'Original is inaccessible' });
  const transformed = await deps.transforms.crop({ context, request }, options);
  if (!transformed.ok) return transformed;
  const crop = cropSchema.safeParse(transformed.value);
  if (!crop.success) return fail({ code: 'unavailable', message: 'Invalid crop result' });
  if (crop.data.assetId !== request.assetId || crop.data.placement !== request.placement || crop.data.presetVersion !== request.presetVersion) return fail({ code: 'conflict', message: 'Crop request mismatch' });
  if (crop.data.rendition.workspaceId !== context.scope.workspaceId || crop.data.rendition.storageKey === original.value.blob.storageKey) return fail({ code: 'conflict', message: 'Crop must preserve the original' });
  return deps.repo.saveCrop({ context, crop: crop.data }, options);
}
