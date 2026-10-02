import { registerTransform, resolveMediaRendition, withTransformRegistryLock, sniffContentType, mimeForTransformFormat, MediaValidationError } from '@jini-ai/cms/media';
import type { TransformDefinitionRecord, ImageTransformerPort as JiniImageTransformerPort } from '@jini-ai/cms/media';
import { parseBoundary } from '@open-marketing/contracts';
import type { Outcome, Scope } from '@open-marketing/contracts';
import type { ImageTransformPort, JiniMediaDependencies, MediaObserverPort } from './ports.js';
import type { PlacementCrop, PlacementCropPreset, PlacementCropRequest } from './types.js';
import { createJiniMediaAdapter } from './jini-media.js';
import { selectPreset } from './rules.js';
import { PLACEMENT_CROP_PRESETS } from './presets.js';
import { boundary } from './boundary.js';
import { checkContext, cropRequestSchema, cropSchema, fail, presetSchema, success } from './validation.js';

/** Register immutable placement geometry and delegate non-destructive rendition work to Jini.
 * A preset version is encoded in the transform name; each name has Jini version 1, so old presets remain resolvable.
 * ImageTransformerPort owns decoded-pixel validation; this adapter only accepts exact-size cover/fill presets.
 * @complexity O(p + bytes), p capped at 100 presets. @example createJiniImageTransform({ scope, dependencies })
 */
export function createJiniImageTransform(required: { scope: Scope; dependencies: JiniMediaDependencies }, optional?: { observer?: MediaObserverPort; placementPresets?: readonly PlacementCropPreset[] }): ImageTransformPort {
  const media = createJiniMediaAdapter(required, optional);
  const presets = structuredClone(optional?.placementPresets ?? PLACEMENT_CROP_PRESETS);
  return {
    async crop(input, options) {
      const context = checkContext({ context: input.context, options, scope: required.scope });
      if (!context.ok) return context;
      const request = parseBoundary({ schema: cropRequestSchema, input: input.request });
      if (!request.ok) return request;
      const preset = selectPreset({ presets, request: request.value });
      if (!preset.ok) return preset;
      const asset = await media.get({ context: input.context, assetId: request.value.assetId }, options);
      if (!asset.ok) return asset;
      if (asset.value.record.status !== 'active') return fail({ code: 'forbidden', message: 'Asset is not active' });
      return boundary({ context: input.context, operation: 'media.transform.crop', run: async () => renderCrop({ ...required, preset: preset.value, request: request.value }) }, optional);
    },
  };
}
/** Shared upstream registry lock serializes registration across adapter instances without nested same-key locking. @complexity O(1) repo calls. */
async function ensureDefinition(required: { scope: Scope; dependencies: JiniMediaDependencies; preset: PlacementCropPreset; name: string }): Promise<Outcome<TransformDefinitionRecord>> {
  const { dependencies: deps, scope, name, preset } = required;
  return withTransformRegistryLock(`om-preset:${JSON.stringify([scope.ownerId, scope.workspaceId, name])}`, async () => {
    const existing = await deps.transformRepo.findByNameVersion({ workspaceId: scope.workspaceId, name, version: 1 });
    if (existing) return checkDefinition({ definition: existing, preset, scope, name });
    const registered = await registerTransform({ deps, input: { workspaceId: scope.workspaceId, name, params: { ...preset.params }, owner: 'open-marketing.media-library' } });
    return checkDefinition({ definition: registered.definition, preset, scope, name });
  });
}
function checkDefinition(required: { definition: TransformDefinitionRecord; preset: PlacementCropPreset; scope: Scope; name: string }): Outcome<TransformDefinitionRecord> {
  const { definition, preset } = required;
  if (definition.workspaceId !== required.scope.workspaceId || definition.name !== required.name || definition.version !== 1) return fail({ code: 'conflict', message: 'Placement transform identity conflict' });
  const params = presetSchema.shape.params.safeParse(definition.params);
  if (!params.success || JSON.stringify(params.data) !== JSON.stringify(preset.params)) return fail({ code: 'conflict', message: 'Placement geometry changed without a new version' });
  if (definition.owner !== 'open-marketing.media-library') return fail({ code: 'conflict', message: 'Placement transform ownership conflict' });
  return success({ value: definition });
}
/** Jini owns output bytes and metadata; original source is never removed or rewritten here. @complexity O(bytes) codec/storage. */
async function renderCrop(required: { scope: Scope; dependencies: JiniMediaDependencies; preset: PlacementCropPreset; request: PlacementCropRequest }): Promise<Outcome<PlacementCrop>> {
  const name = `om-${required.preset.placement}-v${required.preset.version}`;
  const definition = await ensureDefinition({ ...required, name });
  if (!definition.ok) return definition;
  const input = { workspaceId: required.scope.workspaceId, assetId: required.request.assetId, transformName: name, version: 1 };
  const deps = { ...required.dependencies, imageTransformer: boundedTransformer({ transformer: required.dependencies.imageTransformer }) };
  const resolved = await resolveMediaRendition({ deps, input });
  if (resolved.outcome !== 'ok') return fail({ code: 'unavailable', message: 'Placement rendition could not be resolved' });
  if (!(resolved.bytes instanceof Uint8Array) || resolved.bytes.byteLength > 25_000_000) return fail({ code: 'unavailable', message: 'Invalid rendition output' });
  const rendition = await required.dependencies.renditionRepo.findOne(input);
  const crop = cropSchema.safeParse({ ...required.request, cropId: rendition?.id, rendition });
  if (!crop.success) return fail({ code: 'unavailable', message: 'Invalid rendition metadata' });
  if (crop.data.rendition.workspaceId !== required.scope.workspaceId || crop.data.rendition.transformName !== name || crop.data.rendition.version !== 1) return fail({ code: 'forbidden', message: 'Rendition identity mismatch' });
  return success({ value: crop.data });
}

/** Protect original memory-store references and bound codec input/output; reuse Jini's public type sniffer.
 * Decoded dimensions remain the injected codec's responsibility. @complexity O(bytes) copying, <=25 MB each way.
 */
function boundedTransformer(required: { transformer: JiniImageTransformerPort }): JiniImageTransformerPort {
  return {
    async transform(input) {
      if (!(input.bytes instanceof Uint8Array) || input.bytes.byteLength < 1 || input.bytes.byteLength > 25_000_000) throw new MediaValidationError('Invalid transform source size');
      const type = sniffContentType(input.bytes);
      if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/avif'].includes(type)) throw new MediaValidationError('Transform source is not an admitted raster');
      const output = await required.transformer.transform({ bytes: input.bytes.slice(), params: { ...input.params } });
      if (!(output.bytes instanceof Uint8Array) || output.bytes.byteLength < 1 || output.bytes.byteLength > 25_000_000) throw new MediaValidationError('Invalid transform output size');
      if (output.contentType !== mimeForTransformFormat(input.params.format)) throw new MediaValidationError('Transform output type mismatch');
      return { bytes: output.bytes.slice(), contentType: output.contentType };
    },
  };
}
