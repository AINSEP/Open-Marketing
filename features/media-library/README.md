# media-library

OM adds marketing provenance, rights, costs and placement links to canonical **@jini-ai/cms/media 0.3.11** assets. Jini owns asset/blob/rendition records, content addressing, the transform registry and the image codec. There is no parallel OM asset table. Only public Jini exports are used.

The factory is inert. It implements listing, non-destructive placement crops, provenance recording and cost recording. `importAsset` can associate a known content digest with a new operation without fetching; new URL ingestion returns typed `not_implemented` through the deferred importer. Failures never grant authority, silently retry an ambiguous write or delete a shared original.

## Composition and usage

Bind real adapters to a host-authenticated `Scope`. The server owns dependencies, SQLite connections, storage roots, authorization and lifecycle. An owner principal is checked against its owner ID; agent/service contexts require authentication and grant validation in the host before feature calls. Workspace IDs must be globally assigned to one owner in shared Jini repositories (Jini records carry workspace IDs, not owner IDs).

```ts
import {
  createMediaLibrary, createSqlMediaRepo, createJiniMediaAdapter,
  createJiniBlobStore, createJiniImageTransform, createMemoryGuardedAssetImport,
} from '@open-marketing/media-library';

const media = createJiniMediaAdapter({ scope, dependencies: jiniDependencies });
const repo = createSqlMediaRepo({ scope, db: serverDbConnection });
const library = createMediaLibrary({
  repo, media,
  blobs: createJiniBlobStore({ scope, store: jiniDependencies.blobStore }),
  importer: createMemoryGuardedAssetImport({ scope }), // explicit unavailable seam
  transforms: createJiniImageTransform({ scope, dependencies: jiniDependencies }),
  clock, ids, audit: serverMediaAudit,
});

await library.recordCost({ context, cost: {
  observationId: 'estimate-1', operationId: 'generation-1',
  amount: { currency: 'USD', minorUnits: 35 }, kind: 'estimated',
} }); // retained even if generation produces no asset
const crop = await library.createCrop({ context, request: {
  assetId: canonicalAssetId, placement: 'ad-square', presetVersion: 1,
} }); // new rendition; original preserved; inspect crop.ok before use
```

Populate canonical assets via public Jini `uploadMedia` in the host's guarded upload path; `JiniMediaPort.save` registers an already-ingested canonical record, requires source bytes and refuses replacement. OM intentionally exposes no second byte-upload algorithm. Jini record reads return `provenance: null`; marketing evidence is read with `repo.evidence({ context, operationId })`. Import results include the current operation's provenance.

For hermetic composition, `createMemoryJiniDependencies({ clock, ids })` supplies Jini's published repositories, blob store and transform double. Share those dependencies between `createMemoryJiniMedia` and `createMemoryImageTransform`. Empty argument objects remain supported for all original memory factories; their explicit convenience scope is `{ ownerId: 'owner', workspaceId: 'workspace' }`. Each factory instance has independent state.

## Evidence and storage

Provenance is immutable per operation. An unattached root is retained before ingestion; adding an asset association appends another record. Repeated identical writes are idempotent; a changed operation/observation/crop binding returns `conflict`. Costs can precede assets. Estimated and actual observations coexist; corrections reference an existing observation of the same operation/currency and append a replacement observation, rather than signed debits or mutable totals. This is evidence, not an authoritative spend ledger.

Apply `migrations/0001_media_evidence.sql` through the server migration runner. The feature never executes DDL or starts services. SQL uses the existing server's structural query shape and `$n` parameters, without importing its implementation or a driver. A provenance root and later association are intentionally separate appends: if association fails, root evidence remains; the operation returns a failure. Crop IDs are stable Jini rendition IDs.

Blob wrappers reuse Jini `putIfAbsent`, copy bytes at boundaries, reject traversal/foreign keys, verify digest and enforce a 25 MB buffer cap. They serialize same-key writes within a process. Removing bytes is for the host's GC/compensation authority, not arbitrary product requests. The wrapper cannot authenticate a caller or establish whether a blob is still referenced. Uncertain/partial writes return `unavailable` and remain for host/Jini reconciliation; originals are never deleted as speculative compensation.

Placement versions use names such as `om-ad-square-v1`, each with Jini transform version 1. This retains old OM presets without relying on Jini's latest-version generation gate. Geometry is immutable; modifying a preset requires a new OM version. Only bounded, exact-size `cover`/`fill` image presets are accepted. Jini's `InMemoryImageTransformer` is a deterministic byte double, not a pixel codec.

## Bounds and release limitations

Pages contain at most 100 assets; adapter sorting/projection refuses more than 1,000 loaded canonical records. Cursors are scoped canonical IDs; deleted/inaccessible cursor IDs fail explicitly. Jini's underlying `listMedia` still materializes the entire workspace before this cap can be applied. Evidence reads are capped at 1,000 rows per operation. Presets are capped at 100 and dimensions at 8,000 pixels each. Abort is checked before dispatch; Jini 0.3.11 does not accept cancellation/deadline propagation into DB/codec work. Host workers must bound execution.

Deferred / NEEDS:

- Public Jini `./media/import` export: URL fetching, DNS/SSRF/redirect/MIME/decoded-size checks and ingress cleanup remain unavailable. Unavailability tests are not ingress acceptance evidence.
- Durable canonical Jini repositories are a host concern. OM supplies durable **marketing metadata** only; server composition must bind Jini repo ports to its database.
- Real codec/pixel-dimension acceptance requires the host's installed image transformer. This job tests the OM/Jini transform wrapper with Jini's published deterministic double, never claims it resizes pixels.
- Jini local filesystem `putIfAbsent` can leave partial files when a write fails; the wrapper detects corruption, preserves shared content and fails closed. Crash-safe atomic byte publication/repair and rendition orphan cleanup remain upstream/host work. Jini's lazy rendition service writes bytes before its rendition metadata, without compensating orphan cleanup.
- Host durable audit binding, outbox/worker composition, authenticated HTTP/studio/CLI surfaces, DB/codec timeouts and cross-process locking belong to integration. No unauthorized root/platform/app changes are made here.

## Verification

`tests/contract/port-suites.ts` is the shared behavioral suite for all original ports. It is registered for memory doubles and the real adapters supplied by this feature (SQL metadata, temporary filesystem blob storage, injected Jini canonical/transform wrappers). Core tests include dedupe/provenance preservation, failure evidence, stable crops, scope denial, tainted outputs, concurrent identical writes/crops, currency correction conflicts and typed dependency errors.

Owner override: tests, builds, lint and `om:check` are **written, not run**. Only one package-scoped typecheck is permitted. Coordinator performs combined verification later. No red/green regression or runtime acceptance is claimed without test execution.
