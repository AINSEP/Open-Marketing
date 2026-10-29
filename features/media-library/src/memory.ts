import { InMemoryMediaRepo, InMemoryAssetBlobRepo, InMemoryAssetRenditionRepo, InMemoryTransformDefinitionRepo, InMemoryBlobStore, InMemoryImageTransformer, sniffContentType } from '@jini-ai/cms/media';
import { idSchema, notImplemented, parseBoundary } from '@open-marketing/contracts';
import type { CallContext, ClockPort, IdPort, Outcome, ObserverEvent, Scope, ObserverPort } from '@open-marketing/contracts';
import type { EvidenceRow, EvidenceStore } from './evidence-repo.js';
import { createEvidenceRepo } from './evidence-repo.js';
import { createJiniMediaAdapter } from './jini-media.js';
import { createJiniBlobStore } from './blob-adapter.js';
import { createJiniImageTransform } from './transform-adapter.js';
import type { MediaRepoPort, JiniMediaPort, JiniMediaDependencies, BlobStorePort, GuardedAssetImportPort, ImageInspectionPort, ImageTransformPort, MediaAuditPort } from './ports.js';
import type { ImageInspection, PlacementCropPreset } from './types.js';
import { createJiniGuardedAssetImport } from './import-adapter.js';
import { createMemoryImageInspection } from './image-inspection.js';
import { checkContext, fail, importSchema, scopeKey, success } from './validation.js';

/** Convenience doubles default to this explicit test scope; production adapters require a bound scope. */
const testScope: Scope = { ownerId: 'owner', workspaceId: 'workspace' };
/** Jini owns all canonical in-memory repositories and algorithms. Caller supplies deterministic clock/IDs.
 * @example createMemoryJiniDependencies({ clock, ids }) @complexity O(1) setup, no effects.
 */
export function createMemoryJiniDependencies(required: { clock: ClockPort; ids: IdPort }): JiniMediaDependencies {
  return { mediaRepo: new InMemoryMediaRepo({}), blobRepo: new InMemoryAssetBlobRepo({}), renditionRepo: new InMemoryAssetRenditionRepo({}),
    transformRepo: new InMemoryTransformDefinitionRepo({}), blobStore: new InMemoryBlobStore(), imageTransformer: new InMemoryImageTransformer(),
    clock: { nowMs() { return required.clock.now({}); } }, idGen: { newId() { return required.ids.next({}); } } };
}
/** Deterministic test dependencies only; no wall clock, randomness or singleton state. */
function defaultDependencies(): JiniMediaDependencies {
  let sequence = 0;
  return createMemoryJiniDependencies({ clock: { now() { return 0; } }, ids: { next() { sequence += 1; return `memory-${sequence}`; } } });
}
/** Scoped append-only marketing evidence double (no canonical assets). @complexity O(e), bounded reads.
 * @example createMemoryMediaRepo({ scope })
 */
export function createMemoryMediaRepo(required: { scope?: Scope }, optional?: { observer?: ObserverPort }): MediaRepoPort {
  const rows = new Map<string, EvidenceRow>();
  const store: EvidenceStore = {
    async append(input) { return appendMemory({ rows, ...input }); },
    async read(input) {
      const prefix = scopeKey(input) + ':';
      const selected = Array.from(rows.entries()).filter(([key, row]) => key.startsWith(prefix) && row.operationId === input.operationId).map(([, row]) => structuredClone(row));
      if (selected.length > 1000) return fail({ code: 'limit_exceeded', message: 'Evidence exceeds read limit' });
      selected.sort((left, right) => (left.kind + left.key).localeCompare(right.kind + right.key, 'en'));
      return success({ value: selected });
    },
  };
  return createEvidenceRepo({ store, scope: required.scope ?? testScope }, optional);
}
/** Memory append is atomic (no await before the Map mutation); conflicting retries never overwrite. @complexity O(1). */
function appendMemory(required: { rows: Map<string, EvidenceRow>; context: CallContext; row: EvidenceRow }): Outcome<void> {
  const key = scopeKey(required) + ':' + JSON.stringify([required.row.kind, required.row.key]);
  const previous = required.rows.get(key);
  if (previous && (previous.payload !== required.row.payload || previous.operationId !== required.row.operationId)) return fail({ code: 'conflict', message: 'Append-only evidence conflict' });
  if (!previous) required.rows.set(key, structuredClone(required.row));
  return success({ value: undefined });
}
/** Jini-backed canonical double. Inject shared dependencies to populate through public uploadMedia.
 * @example createMemoryJiniMedia({ scope, dependencies }) @complexity Adapter-dependent, list cap 1,000.
 */
export function createMemoryJiniMedia(required: { scope?: Scope; dependencies?: JiniMediaDependencies }): JiniMediaPort {
  return createJiniMediaAdapter({ scope: required.scope ?? testScope, dependencies: required.dependencies ?? defaultDependencies() });
}
/** Uses Jini's atomic content-addressed in-memory store; inputs/outputs are copied by the OM adapter.
 * @example createMemoryBlobStore({ scope }) @complexity O(bytes), max 25 MB.
 */
export function createMemoryBlobStore(required: { scope?: Scope }): BlobStorePort {
  return createJiniBlobStore({ scope: required.scope ?? testScope, store: new InMemoryBlobStore() });
}
/** Strict URL/byte fixture double over the published Jini importer; unknown URLs are refused without I/O.
 * Empty fixtures keep the original explicit not_implemented convenience behavior.
 * No DNS/redirect/codec proof is claimed by this double. @complexity O(bytes + fixtures), cap 100 fixtures.
 * @example createMemoryGuardedAssetImport({ scope, dependencies, fixtures: [{ sourceUrl, bytes, image }] })
 */
export function createMemoryGuardedAssetImport(required: { scope?: Scope; dependencies?: JiniMediaDependencies; fixtures?: readonly { sourceUrl: string; bytes: Uint8Array; image: ImageInspection }[] }): GuardedAssetImportPort {
  if (required.fixtures?.length) return fixtureImporter(required);
  return {
    async upload(input, options) {
      const context = checkContext({ context: input.context, options, scope: required.scope ?? testScope });
      if (!context.ok) return context;
      return notImplemented({ operation: 'media-library.upload (no memory fixture configured)' });
    },
    async import(input, options) {
      const context = checkContext({ context: input.context, options, scope: required.scope ?? testScope });
      if (!context.ok) return context;
      const request = parseBoundary({ schema: importSchema, input: input.request });
      if (!request.ok) return request;
      return notImplemented({ operation: 'media-library.urlImport (no memory fixture configured)' });
    },
  };
}
/** Only configured exact HTTPS URLs produce replies; direct transport usage always fails. */
function fixtureImporter(required: { scope?: Scope; dependencies?: JiniMediaDependencies; fixtures?: readonly { sourceUrl: string; bytes: Uint8Array; image: ImageInspection }[] }): GuardedAssetImportPort {
  const scope = required.scope ?? testScope;
  const fixtures = (required.fixtures ?? []).slice(0, 100).map(fixture => ({ ...fixture, bytes: fixture.bytes.slice(), image: structuredClone(fixture.image) }));
  const inspection = createMemoryImageInspection({ scope, fixtures: fixtures.map(fixture => ({ ...fixture, contentType: sniffContentType(fixture) })) });
  return createJiniGuardedAssetImport({ scope, dependencies: required.dependencies ?? defaultDependencies(), inspection,
    httpClient: { async send() { throw new Error('Memory transport must not be called directly'); } },
    outboundGuard: { async send(input) {
      const fixture = fixtures.find(item => item.sourceUrl === input.request.url);
      if (!fixture) throw new Error('Unconfigured memory URL');
      return { status: 200, headers: {}, bodyText: '', bodyBytes: fixture.bytes.slice(), bodyBytesTruncated: false, finalUrl: fixture.sourceUrl };
    } },
  });
}
/** Uses Jini's deterministic transform double (not a pixel codec). Share dependencies with the media double.
 * @example createMemoryImageTransform({ scope, dependencies }) @complexity O(bytes + presets).
 */
export function createMemoryImageTransform(required: { scope?: Scope; dependencies?: JiniMediaDependencies }, optional?: { placementPresets?: readonly PlacementCropPreset[]; inspection?: ImageInspectionPort }): ImageTransformPort {
  return createJiniImageTransform({ scope: required.scope ?? testScope, dependencies: required.dependencies ?? defaultDependencies() }, optional);
}
/** Idempotent audit double; one operation cannot silently change its asset binding. No generation authority.
 * @example createMemoryMediaAudit({ scope }) @complexity O(1).
 */
export function createMemoryMediaAudit(required: { scope?: Scope }): MediaAuditPort {
  const records = new Map<string, string>();
  return {
    async record(input, options) {
      const context = checkContext({ context: input.context, options, scope: required.scope ?? testScope });
      if (!context.ok) return context;
      if (!idSchema.safeParse(input.operationId).success || !idSchema.safeParse(input.assetId).success) return fail({ code: 'invalid_input', message: 'Invalid audit binding' });
      const key = scopeKey(input) + ':' + input.operationId;
      const previous = records.get(key);
      if (previous && previous !== input.assetId) return fail({ code: 'conflict', message: 'Audit binding conflict' });
      records.set(key, input.assetId);
      return success({ value: undefined });
    },
  };
}
/** Bounded observer double for contract/telemetry assertions; callers can snapshot and clear recorded events.
 * @example createMemoryMediaObserver({}) @complexity O(1) append, O(n) snapshot, cap 1,000.
 */
export function createMemoryMediaObserver(required: Record<string, never>): ObserverPort & { events(required: Record<string, never>): readonly ObserverEvent[]; reset(required: Record<string, never>): void } {
  const events: ObserverEvent[] = [];
  return {
    observe(event) { if (events.length === 1000) events.shift(); events.push(structuredClone(event)); },
    events() { return structuredClone(events); },
    reset() { events.length = 0; },
  };
}
