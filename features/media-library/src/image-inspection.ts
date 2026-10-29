import { createHash } from 'node:crypto';
import { z } from 'zod';
import { parseBoundary } from '@open-marketing/contracts';
import type { CallContext, CallOptions, Outcome, Scope, ObserverPort } from '@open-marketing/contracts';
import type { ImageInspectionPort } from './ports.js';
import type { ImageInspection, ImageInspectionLimits } from './types.js';
import { boundary } from './boundary.js';
import { checkContext, fail, success } from './validation.js';

/** Raster-only ingress; SVG/HTML, audio and video require different guarded pipelines. */
export const IMAGE_CONTENT_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/avif'] as const;
/** Default to still images and 40 million decoded pixels; hosts may supply smaller bounds. */
export const DEFAULT_IMAGE_LIMITS: ImageInspectionLimits = { maxEdge: 8000, maxPixels: 40_000_000, maxFrames: 1 };
const imageSchema = z.strictObject({ width: z.number().int().positive().max(100000), height: z.number().int().positive().max(100000), frames: z.number().int().positive().max(10000) });
const inputSchema = z.object({ bytes: z.instanceof(Uint8Array).refine(bytes => bytes.byteLength > 0 && bytes.byteLength <= 25_000_000),
  contentType: z.enum(IMAGE_CONTENT_TYPES), maxPixels: z.number().int().positive().max(40_000_000) });
export const imageLimitsSchema = z.strictObject({ maxEdge: z.number().int().positive().max(8000), maxPixels: inputSchema.shape.maxPixels, maxFrames: z.number().int().positive().max(100) });

/** Adapter for a host codec's full decode. Copies bytes; tainted metadata and opaque failures become Outcomes.
 * decode must enforce the supplied pixel bound BEFORE allocation, including every frame, and accept cancellation.
 * No codec is constructed here. @complexity O(bytes + decoded pixels), input cap 25 MB.
 * @example createImageInspectionAdapter({ scope, decode: hostImageDecoder })
 */
export function createImageInspectionAdapter(required: { scope: Scope; decode: (required: { bytes: Uint8Array; contentType: string; maxPixels: number }, optional?: CallOptions) => Promise<unknown> }, optional?: { observer?: ObserverPort }): ImageInspectionPort {
  return {
    async inspect(input, options) {
      const context = checkContext({ context: input.context, options, scope: required.scope });
      if (!context.ok) return context;
      const parsed = parseBoundary({ schema: inputSchema, input });
      if (!parsed.ok) return parsed;
      return boundary({ context: input.context, operation: 'media.image.inspect', run: async () => {
        const decoded = await required.decode({ ...parsed.value, bytes: parsed.value.bytes.slice() }, options);
        const image = imageSchema.safeParse(decoded);
        if (!image.success) return fail({ code: 'unavailable', message: 'Invalid decoded image metadata' });
        if (image.data.width * image.data.height * image.data.frames > parsed.value.maxPixels) return fail({ code: 'limit_exceeded', message: 'Decoded image exceeds pixel limit' });
        const active = checkContext({ context: input.context, options, scope: required.scope });
        if (!active.ok) return active;
        return success({ value: image.data });
      } }, optional);
    },
  };
}

/** Fingerprint fixture double, never a header parser or pixel decoder; unknown bytes fail closed.
 * @complexity O(bytes + f) setup, O(bytes) reads; f <=100 fixtures. @example createMemoryImageInspection({ scope, fixtures })
 */
export function createMemoryImageInspection(required: { scope: Scope; fixtures: readonly { bytes: Uint8Array; contentType: string; image: ImageInspection }[] }): ImageInspectionPort {
  const entries = required.fixtures.slice(0, 100).map(fixture => ({ digest: fingerprint(fixture), contentType: fixture.contentType, image: structuredClone(fixture.image) }));
  return createImageInspectionAdapter({ scope: required.scope, async decode(input) {
    const fixture = entries.find(entry => entry.digest === fingerprint(input) && entry.contentType === input.contentType);
    return fixture?.image;
  } });
}
function fingerprint(required: { bytes: Uint8Array }): string { return createHash('sha256').update(required.bytes).digest('hex'); }

/** Check decoded edge/frame/pixel totals and propagate aborts before subsequent writes.
 * @complexity O(bytes + decoded pixels); one inspection call, no network or storage.
 */
export async function inspectBounded(required: { inspection: ImageInspectionPort; context: CallContext; bytes: Uint8Array; contentType: string; limits: ImageInspectionLimits; options?: CallOptions }): Promise<Outcome<ImageInspection>> {
  const limits = parseBoundary({ schema: imageLimitsSchema, input: required.limits });
  if (!limits.ok) return limits;
  const inspected = await required.inspection.inspect({ context: required.context, bytes: required.bytes.slice(), contentType: required.contentType, maxPixels: limits.value.maxPixels }, required.options);
  if (!inspected.ok) return inspected;
  const parsed = imageSchema.safeParse(inspected.value);
  if (!parsed.success) return fail({ code: 'unavailable', message: 'Invalid decoded image metadata' });
  if (exceedsLimits({ image: parsed.data, limits: limits.value })) return fail({ code: 'limit_exceeded', message: 'Decoded image exceeds placement limits' });
  const context = checkContext({ context: required.context, options: required.options });
  if (!context.ok) return context;
  return success({ value: parsed.data });
}
function exceedsLimits(required: { image: ImageInspection; limits: ImageInspectionLimits }): boolean {
  const { image, limits } = required;
  return image.width > limits.maxEdge || image.height > limits.maxEdge || image.frames > limits.maxFrames || image.width * image.height * image.frames > limits.maxPixels;
}
