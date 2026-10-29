import { createHash } from 'node:crypto';
import { z } from 'zod';
import { sniffContentType, withSha256Lock } from '@jini-ai/cms/media';
import { buildImportFilename, fetchImage, parseImportUrl } from '@jini-ai/cms/media/import';
import type { FetchImageRequired } from '@jini-ai/cms/media/import';
import { chatAttachmentSchema, parseBoundary } from '@open-marketing/contracts';
import type { CallContext, CallOptions, Outcome, Scope, ObserverPort } from '@open-marketing/contracts';
import type { GuardedAssetImportPort, ImageInspectionPort, JiniMediaDependencies } from './ports.js';
import type { AssetImportRequest, ImageInspectionLimits, ImportedAsset } from './types.js';
import { boundary, MediaBoundaryFailure } from './boundary.js';
import { createJiniBlobStore } from './blob-adapter.js';
import { createJiniMediaAdapter } from './jini-media.js';
import { DEFAULT_IMAGE_LIMITS, IMAGE_CONTENT_TYPES, imageLimitsSchema, inspectBounded } from './image-inspection.js';
import { uploadCanonical } from './import-upload.js';
import { checkContext, fail, importSchema, success } from './validation.js';

/** The server supplies Jini's guarded egress and a bounded codec; this feature constructs neither. */
export type JiniAssetImportDependencies = { scope: Scope; dependencies: JiniMediaDependencies; inspection: ImageInspectionPort;
  httpClient: FetchImageRequired['httpClient']; outboundGuard: FetchImageRequired['outboundGuard'] };
type ImportOptions = { observer?: ObserverPort; maxBytes?: number; timeoutMs?: number; imageLimits?: ImageInspectionLimits };
const uploadSchema = z.object({ bytes: z.instanceof(Uint8Array).refine(bytes => bytes.byteLength > 0 && bytes.byteLength <= 1048576),
  filename: chatAttachmentSchema.shape.name, contentTypes: z.array(z.enum(IMAGE_CONTENT_TYPES)).min(1).max(5) });
const configurationSchema = z.strictObject({ maxBytes: z.number().int().min(1).max(25_000_000), timeoutMs: z.number().int().min(1).max(20_000) });
const responseSchema = z.object({ status: z.number().int().min(100).max(599), headers: z.record(z.string().max(256), z.string().max(8192)),
  bodyText: z.string().max(75_000_000), bodyBytes: z.instanceof(Uint8Array).optional(), bodyTruncated: z.boolean().optional(),
  bodyBytesTruncated: z.boolean().optional(), finalUrl: z.url().max(2048).optional() });

/** Public Jini fetch/validate/upload adapter. One guarded request, no blind retry, scoped digest dedupe.
 * The guard MUST enforce DNS/IP/peer pinning and every redirect hop; raw/preflight-only bindings are invalid.
 * Existing content is checked without network access. New content is inspected before any storage write.
 * @complexity O(bytes + decoded pixels + workspace assets), max 25 MB, 20s egress deadline; upstream list is unpaginated.
 * @example createJiniGuardedAssetImport({ scope, dependencies, httpClient, outboundGuard, inspection })
 */
export function createJiniGuardedAssetImport(required: JiniAssetImportDependencies, optional?: ImportOptions): GuardedAssetImportPort {
  return {
    async upload(input, options) {
      const context = checkContext({ context: input.context, scope: required.scope, options });
      if (!context.ok) return context;
      const parsed = parseBoundary({ schema: uploadSchema, input });
      if (!parsed.ok) return parsed;
      return boundary({ context: input.context, operation: 'media.upload.guarded', run: async () => {
        const bytes = parsed.value.bytes.slice();
        const digest = createHash('sha256').update(bytes).digest('hex');
        return withSha256Lock({ key: `om-import:${JSON.stringify([required.scope, digest])}`, criticalSection: () =>
          admitImage({ ...required, context: input.context, ...parsed.value, bytes, options,
            imageLimits: DEFAULT_IMAGE_LIMITS }, optional) });
      } }, optional);
    },
    async import(input, options) {
      const context = checkContext({ context: input.context, scope: required.scope, options });
      if (!context.ok) return context;
      const request = parseBoundary({ schema: importSchema, input: input.request });
      if (!request.ok) return request;
      const config = parseBoundary({ schema: configurationSchema, input: { maxBytes: optional?.maxBytes ?? 10_000_000, timeoutMs: optional?.timeoutMs ?? 20_000 } });
      if (!config.ok) return config;
      const limits = parseBoundary({ schema: imageLimitsSchema, input: optional?.imageLimits ?? DEFAULT_IMAGE_LIMITS });
      if (!limits.ok) return limits;
      return boundary({ context: input.context, operation: 'media.import.guarded', run: async () => {
        parseImportUrl({ raw: request.value.sourceUrl });
        return withSha256Lock({ key: `om-import:${JSON.stringify([required.scope, request.value.expectedDigest])}`, criticalSection: async () => {
          return importCanonical({ ...required, context: input.context, request: request.value, options, ...config.value, imageLimits: limits.value }, optional);
        } });
      } }, optional);
    },
  };
}

type ImportCall = JiniAssetImportDependencies & { context: CallContext; request: AssetImportRequest; options?: CallOptions; maxBytes: number; timeoutMs: number; imageLimits: ImageInspectionLimits };
/** Lock scope covers dedupe and upload; Jini's upload lock uses a separate key. @complexity O(bytes + workspace assets). */
async function importCanonical(required: ImportCall, optional?: ImportOptions): Promise<Outcome<ImportedAsset>> {
  const media = createJiniMediaAdapter({ scope: required.scope, dependencies: required.dependencies });
  const existing = await media.findByDigest({ context: required.context, contentDigest: required.request.expectedDigest }, required.options);
  if (!existing.ok) return existing;
  if (existing.value) return inspectExisting({ ...required, asset: existing.value });
  const fetched = await fetchImage({ url: required.request.sourceUrl, httpClient: required.httpClient, outboundGuard: guardedTransport(required),
    maxBytes: required.maxBytes, allowedContentTypes: new Set(IMAGE_CONTENT_TYPES), sniffer: { sniff: sniffContentType } }, { timeoutMs: required.timeoutMs });
  const bytes = fetched.bytes.slice();
  if (createHash('sha256').update(bytes).digest('hex') !== required.request.expectedDigest) return fail({ code: 'conflict', message: 'Import digest mismatch' });
  const asset = await admitImage({ ...required, bytes, contentTypes: IMAGE_CONTENT_TYPES,
    filename: buildImportFilename({ url: fetched.url, contentType: fetched.contentType }) }, optional);
  if (!asset.ok) return asset;
  return success({ value: { ...asset.value, provenance: required.request.provenance } });
}
/** Both URL imports and direct uploads share inspection, digest dedupe and canonical publication.
 * Caller holds the scope/digest lock; no storage write occurs before byte/decoded-format admission.
 * @complexity O(bytes + decoded pixels + workspace assets); one bounded image, at most 1,000 assets.
 */
async function admitImage(required: Pick<ImportCall, 'scope' | 'dependencies' | 'inspection' | 'context' | 'options' | 'imageLimits'> & {
  bytes: Uint8Array; filename: string; contentTypes: readonly string[] }, optional?: ImportOptions): Promise<Outcome<ImportedAsset>> {
  const contentType = sniffContentType({ bytes: required.bytes });
  if (!required.contentTypes.includes(contentType)) return fail({ code: 'invalid_input', message: 'Unsupported image format' });
  const inspected = await inspectBounded({ ...required, contentType, limits: required.imageLimits });
  if (!inspected.ok) return inspected;
  const media = createJiniMediaAdapter({ scope: required.scope, dependencies: required.dependencies });
  const existing = await media.findByDigest({ context: required.context, contentDigest: createHash('sha256').update(required.bytes).digest('hex') }, required.options);
  if (!existing.ok) return existing;
  if (existing.value) return success({ value: existing.value });
  return uploadCanonical({ context: required.context, deps: required.dependencies, bytes: required.bytes, contentType,
    filename: required.filename, options: required.options }, optional);
}
/** Even direct importer dedupe validates stored bytes/dimensions; known media is never blindly re-fetched. */
async function inspectExisting(required: ImportCall & { asset: ImportedAsset }): Promise<Outcome<ImportedAsset>> {
  const blobs = createJiniBlobStore({ scope: required.scope, store: required.dependencies.blobStore });
  const bytes = await blobs.read({ context: required.context, storageKey: required.asset.blob.storageKey }, required.options);
  if (!bytes.ok) return bytes;
  if (bytes.value.byteLength > required.maxBytes) return fail({ code: 'limit_exceeded', message: 'Existing asset exceeds import byte limit' });
  const inspected = await inspectBounded({ ...required, bytes: bytes.value, contentType: sniffContentType({ bytes: bytes.value }), limits: required.imageLimits });
  if (!inspected.ok) return inspected;
  return success({ value: { ...required.asset, provenance: required.request.provenance } });
}

/** Preserve scope correlation/abort/deadline at the sole egress path and schema-check tainted replies.
 * The injected guard, not URL string inspection, owns connect-time SSRF and redirect enforcement.
 */
function guardedTransport(required: ImportCall): FetchImageRequired['outboundGuard'] {
  return { async send(input) {
    const context = checkContext({ context: required.context, options: required.options });
    if (!context.ok) throw new MediaBoundaryFailure({ error: context.error });
    const request = { ...input.request, signal: required.options?.signal, totalDeadlineMs: required.timeoutMs,
      headers: { ...input.request.headers, 'x-correlation-id': required.context.correlationId, 'x-trace-id': required.context.traceId,
        ...(required.context.runId ? { 'x-run-id': required.context.runId } : {}) } };
    const response = await required.outboundGuard.send({ ...input, request });
    const parsed = responseSchema.safeParse(response);
    if (!parsed.success) throw new MediaBoundaryFailure({ error: { code: 'unavailable', message: 'Invalid guarded HTTP response', retryable: false } });
    if (parsed.data.finalUrl) parseImportUrl({ raw: parsed.data.finalUrl });
    return parsed.data;
  } };
}
