# media-library

A thin OM layer over **@jini-ai/cms 0.5.6**. Jini owns canonical asset/blob/rendition records, hashing, upload, transforms and garbage collection. OM owns append-only marketing provenance, rights, cost observations and placement links. Public OM imports use `@open-marketing/media-library`.

The factories are inert. The server injects authenticated scopes, Jini repositories, storage, clock/IDs, guarded egress, a bounded image decoder and durable audit. No vendor SDK, credential or configuration is embedded in the feature.

## Composition

```ts
import {
  createMediaLibrary, createSqlMediaRepo, createJiniMediaAdapter,
  createJiniBlobStore, createJiniGuardedAssetImport, createJiniImageTransform,
  createImageInspectionAdapter,
} from '@open-marketing/media-library';

const inspection = createImageInspectionAdapter({ scope, decode: hostImageDecoder });
const importer = createJiniGuardedAssetImport({
  scope, dependencies: jiniDependencies, inspection,
  httpClient: serverGuardedClient,
  outboundGuard: serverOutboundGuard,
});
const library = createMediaLibrary({
  repo: createSqlMediaRepo({ scope, db: serverDbConnection }),
  media: createJiniMediaAdapter({ scope, dependencies: jiniDependencies }),
  blobs: createJiniBlobStore({ scope, store: jiniDependencies.blobStore }),
  importer,
  transforms: createJiniImageTransform(
    { scope, dependencies: jiniDependencies }, { inspection },
  ),
  clock, ids, audit: serverMediaAudit,
});

await library.recordCost({ context, cost: {
  observationId: 'estimate-1', operationId: 'generation-1',
  amount: { currency: 'USD', minorUnits: 35 }, kind: 'estimated',
} }); // retained even when generation produces no asset

const asset = await library.importAsset({ context, request: {
  sourceUrl, expectedDigest, operationId: provenance.operationId, provenance,
} });
if (asset.ok) {
  await library.createCrop({ context, request: {
    assetId: asset.value.record.id, placement: 'ad-square', presetVersion: 1,
  } }); // inspect the Outcome before using the rendition
}
```

The injected outbound guard must enforce destination policy, DNS/IP validation, socket peer pinning, every redirect hop, decompressed-byte bounds and the total deadline. A raw HTTP client or URL preflight is not a valid guard. The feature uses public Jini `fetchImage`, `parseImportUrl`, `validateImageBytes` (through fetch), `buildImportFilename` and `uploadMedia`; it does not implement a second fetch/import algorithm. Correlation/trace/run IDs and cancellation travel through the guarded request. Headers and filenames do not authorize MIME: sniffed bytes do.

`hostImageDecoder` receives `{ bytes, contentType, maxPixels }` and optional `CallOptions`. It must fully validate the image, enforce the total decoded pixel bound **before allocation**, cover every frame, honor cancellation and bound execution time. It returns `{ width, height, frames }`. Jini 0.5.6's public transformer does not expose this metadata, so the host must supply the inspection binding. Default limits are 8,000 pixels per edge, 40 million total pixels and one frame. Import defaults to 10 MB and a 20-second egress deadline; byte caps cannot exceed 25 MB. Unsafe schemes/embedded credentials, missing/truncated bytes, unsupported raster types, digest mismatch and excessive dimensions are explicit failures before canonical publication.

## Persistence and retries

Provenance is write-once per operation. An unattached root is retained before ingestion; later asset association appends a link. Identical retries are idempotent, changed bindings conflict. Estimated/actual/corrective costs can exist without assets. Corrections append and reference an existing observation of the same operation/currency. These records are evidence, not spend authorization or an authoritative financial ledger.

Apply the existing `migrations/0001_media_evidence.sql` only through the authorized server migration operation. This feature performs no DDL at import/factory time. `MediaSqlPort` is an injected structural query seam; production code imports no database driver.

Known canonical digests are reused by the service without URL fetching; each operation retains its supplied provenance. The direct importer also rechecks stored bytes and dimensions. Concurrent direct imports serialize lookup/upload within one process. Jini canonical records retain creator attribution independently of shared blobs; `get`/`list` return `provenance: null`, and marketing evidence is read through `repo.evidence`.

Upload delegates to Jini using a create-only, digest-verifying byte wrapper. A failed upload rolls back only its newly minted media/rendition rows via public `rollbackUploadedMedia`, then tombstones its unreferenced new blob row via public `tombstoneBlobIfUnreferenced`. Compensation does not delete shared bytes. Torn writes or failures before blob-row publication may leave orphan bytes; failures are explicit and require host reconciliation/GC. No automatic retry is performed for unknown outcomes.

## Placement crops and doubles

Presets include square, portrait, story and landscape. Names encode the OM version, e.g. `om-ad-square-v1` with Jini transform version 1. Changing geometry requires a new OM preset version. Exact-size `cover`/`fill` presets are admitted. Originals are copied before codec calls and never rewritten/deleted during cropping.

Bind `inspection` to `createJiniImageTransform` in production: it validates source limits and exact output dimensions before rendition publication, and checks cached outputs too. Omitting inspection preserves the existing injected-codec contract; pixel validity is then entirely the codec's responsibility and is not OM dimension-acceptance evidence. Jini's `InMemoryImageTransformer` is a byte double, not a pixel codec.

`createMemoryJiniDependencies({ clock, ids })` supplies Jini's published repositories/storage/transform double. Share dependencies across media/import/transform doubles. Original empty-object memory calls remain supported with explicit test scope `{ ownerId: 'owner', workspaceId: 'workspace' }`. `createMemoryGuardedAssetImport` accepts exact URL/byte/image fixtures; without fixtures it returns typed `not_implemented`. `createMemoryImageInspection` recognizes fixture fingerprints only; it never decodes pixels or proves SSRF policy.

## Remaining integration and verification

The host authenticates contexts and assigns globally unique workspace-to-owner mappings; Jini itself scopes records by workspace only. Durable canonical repositories/audit, a real bounded decoder, published platform guard binding, worker deadlines, cross-process transactions and HTTP/studio/CLI integration remain with the Coordinator. Listing still materializes all Jini workspace records before OM's 1,000-row cap; evidence reads cap at 1,000, pages at 100, presets at 100.

Shared memory/SQL metadata and memory/temporary-filesystem byte suites are retained. Import/inspection shared suites and fault-injection cases are written. They exercise published Jini code with injected dependencies; they do not certify actual DNS/peer/redirect enforcement or real pixel decoding. Owner override forbids test/lint/build/install runs. The single permitted package typecheck result is recorded in `HANDOFF.md`.
