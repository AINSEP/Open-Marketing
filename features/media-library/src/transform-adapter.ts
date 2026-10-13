import { registerTransform, resolveMediaRendition, withTransformRegistryLock, sniffContentType, mimeForTransformFormat, MediaValidationError } from '@jini-ai/cms/media';
import type { TransformDefinitionRecord, ImageTransformerPort as JiniImageTransformerPort } from '@jini-ai/cms/media';
import { parseBoundary } from '@open-marketing/contracts';
import type { CallContext, CallOptions, Outcome, Scope } from '@open-marketing/contracts';
import type { ImageInspectionPort, ImageTransformPort, JiniMediaDependencies, MediaObserverPort } from './ports.js';
import type { PlacementCrop, PlacementCropPreset, PlacementCropRequest } from './types.js';
import { createJiniMediaAdapter } from './jini-media.js';
import { selectPreset } from './rules.js';
import { PLACEMENT_CROP_PRESETS } from './presets.js';
import { boundary, MediaBoundaryFailure } from './boundary.js';
import { DEFAULT_IMAGE_LIMITS, inspectBounded } from './image-inspection.js';
import { checkContext, cropRequestSchema, cropSchema, fail, presetSchema, success } from './validation.js';

/** Register immutable placement geometry and delegate non-destructive rendition work to Jini.
 * A preset version is encoded in the transform name; each name has Jini version 1, so old presets remain resolvable.
 * Bind inspection in production to enforce decoded input bounds and exact output pixels, including cached renditions.
 * Without inspection the injected codec owns pixel validity; the memory transformer proves orchestration only.
 * @complexity O(p + bytes), p capped at 100 presets. @example createJiniImageTransform({ scope, dependencies })
 */
export function createJiniImageTransform(required: { scope: Scope; dependencies: JiniMediaDependencies }, optional?: { observer?: MediaObserverPort; placementPresets?: readonly PlacementCropPreset[]; inspection?: ImageInspectionPort }): ImageTransformPort {
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
      return boundary({ context: input.context, operation: 'media.transform.crop', run: async () => renderCrop({ ...required, context: input.context, options, inspection: optional?.inspection, preset: preset.value, request: request.value }) }, optional);
    },
  };
}
/** Shared upstream registry lock serializes registration across adapter instances without nested same-key locking. @complexity O(1) repo calls. */
async function ensureDefinition(required: { scope: Scope; dependencies: JiniMediaDependencies; preset: PlacementCropPreset; name: string }): Promise<Outcome<TransformDefinitionRecord>> {
  const { dependencies: deps, scope, name, preset } = required;
  return withTransformRegistryLock({ key: `om-preset:${JSON.stringify([scope.ownerId, scope.workspaceId, name])}`, criticalSection: async () => {
    const existing = await deps.transformRepo.findByNameVersion({ workspaceId: scope.workspaceId, name, version: 1 });
    if (existing) return checkDefinition({ definition: existing, preset, scope, name });
    const registered = await registerTransform({ deps, input: { workspaceId: scope.workspaceId, name, params: { ...preset.params }, owner: 'open-marketing.media-library' } });
    return checkDefinition({ definition: registered.definition, preset, scope, name });
  } });
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
async function renderCrop(required: { scope: Scope; dependencies: JiniMediaDependencies; preset: PlacementCropPreset; request: PlacementCropRequest; context: CallContext; options?: CallOptions; inspection?: ImageInspectionPort }): Promise<Outcome<PlacementCrop>> {
  const name = `om-${required.preset.placement}-v${required.preset.version}`;
  const definition = await ensureDefinition({ ...required, name });
  if (!definition.ok) return definition;
  const input = { workspaceId: required.scope.workspaceId, assetId: required.request.assetId, transformName: name, version: 1 };
  const deps = { ...required.dependencies, imageTransformer: boundedTransformer({ transformer: required.dependencies.imageTransformer, context: required.context, options: required.options, inspection: required.inspection }) };
  const resolved = await resolveMediaRendition({ deps, input });
  if (resolved.outcome !== 'ok') return fail({ code: 'unavailable', message: 'Placement rendition could not be resolved' });
  if (!(resolved.bytes instanceof Uint8Array) || resolved.bytes.byteLength > 25_000_000) return fail({ code: 'unavailable', message: 'Invalid rendition output' });
  const geometry = await checkOutputGeometry({ ...required, bytes: resolved.bytes, contentType: mimeForTransformFormat({ format: required.preset.params.format }), params: required.preset.params });
  if (!geometry.ok) return geometry;
  const rendition = await required.dependencies.renditionRepo.findOne(input);
  const crop = cropSchema.safeParse({ ...required.request, cropId: rendition?.id, rendition });
  if (!crop.success) return fail({ code: 'unavailable', message: 'Invalid rendition metadata' });
  if (crop.data.rendition.workspaceId !== required.scope.workspaceId || crop.data.rendition.transformName !== name || crop.data.rendition.version !== 1) return fail({ code: 'forbidden', message: 'Rendition identity mismatch' });
  return success({ value: crop.data });
}

/** Protect original memory-store references and bound codec input/output; reuse Jini's public type sniffer.
 * Decoded dimensions remain the injected codec's responsibility. @complexity O(bytes) copying, <=25 MB each way.
 */
function boundedTransformer(required: { transformer: JiniImageTransformerPort; context: CallContext; options?: CallOptions; inspection?: ImageInspectionPort }): JiniImageTransformerPort {
  return {
    async transform(input) {
      await validateTransformSource({ ...required, bytes: input.bytes });
      const output = await required.transformer.transform({ bytes: input.bytes.slice(), params: { ...input.params } });
      validateTransformOutput({ ...output, params: input.params });
      const geometry = await checkOutputGeometry({ ...required, bytes: output.bytes, contentType: output.contentType, params: input.params });
      if (!geometry.ok) throw new MediaBoundaryFailure({ error: geometry.error });
      return { bytes: output.bytes.slice(), contentType: output.contentType };
    },
  };
}

/** Byte/type checks precede codec work; optional host inspection bounds the full decoded source. */
async function validateTransformSource(required: { context: CallContext; options?: CallOptions; inspection?: ImageInspectionPort; bytes: Uint8Array }): Promise<void> {
  if (!boundedBytes(required)) throw new MediaValidationError({ message: 'Invalid transform source size' });
  const type = sniffContentType(required);
  if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/avif'].includes(type)) throw new MediaValidationError({ message: 'Transform source is not an admitted raster' });
  if (!required.inspection) return;
  const source = await inspectBounded({ ...required, inspection: required.inspection, contentType: type, limits: DEFAULT_IMAGE_LIMITS });
  if (!source.ok) throw new MediaBoundaryFailure({ error: source.error });
}
function boundedBytes(required: { bytes: Uint8Array }): boolean {
  return required.bytes instanceof Uint8Array && required.bytes.byteLength > 0 && required.bytes.byteLength <= 25_000_000;
}
function validateTransformOutput(required: { bytes: Uint8Array; contentType: string; params: PlacementCropPreset['params'] }): void {
  if (!boundedBytes(required)) throw new MediaValidationError({ message: 'Invalid transform output size' });
  if (required.contentType !== mimeForTransformFormat({ format: required.params.format })) throw new MediaValidationError({ message: 'Transform output type mismatch' });
}

/** Inspect before rendition publication and on cache reads. A matching preset alone is not pixel evidence. */
async function checkOutputGeometry(required: { inspection?: ImageInspectionPort; context: CallContext; options?: CallOptions; bytes: Uint8Array; contentType: string; params: PlacementCropPreset['params'] }): Promise<Outcome<void>> {
  if (!required.inspection) return success({ value: undefined });
  const image = await inspectBounded({ ...required, inspection: required.inspection, limits: DEFAULT_IMAGE_LIMITS });
  if (!image.ok) return image;
  if (image.value.width !== required.params.width || image.value.height !== required.params.height) return fail({ code: 'conflict', message: 'Crop pixels do not match placement dimensions' });
  return success({ value: undefined });
}
