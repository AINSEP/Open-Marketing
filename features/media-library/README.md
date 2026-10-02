# media-library

Public entry: `@open-marketing/media-library` only. Build on **@jini-ai/cms/media**, pinned to the published 0.3.11 release. Only public subpath exports are used.

Jini owns canonical `MediaRecord`, `AssetBlobRecord`, `AssetRenditionRecord`, content-addressed storage, named transform definitions and rendition generation. Reuse its public upload/read/list/transform services and storage/transform ports; `JiniMediaDependencies` describes the injected dependencies. OM adds append-only prompt/model/seed/cost/vendor-terms/rights evidence and links to Jini assets, plus versioned ad-placement presets. `MediaRepoPort` stores this OM metadata only. `JiniMediaPort` and blob/transform ports translate authenticated OM context and typed Outcome errors to the upstream APIs; they do not introduce a parallel asset store.

`createMediaLibrary` adds the required `media` port to the accepted v2 dependencies and accepts optional `placementPresets`. Every operation, including `recordProvenance` and `recordCost`, remains a typed `not_implemented` stub. The exported `PLACEMENT_CROP_PRESETS` describe square, portrait, story and landscape geometry; the feature adapter registers these with Jini's versioned transform registry.

NEEDS: the registry and installed `@jini-ai/cms@0.3.11` exports contain **no `./media/import`**. URL import stays behind `GuardedAssetImportPort` until that public subpath is published; do not deep-import Jini internals or rebuild its importer in OM. The published media code discloses missing ingress/origin policy and unbounded workspace listing; j05 must prove guarded ingress, scope checks, pagination, durable adapters and failure cleanup before admitting capabilities.

B1 scaffolds in `tests/contract` assert explicit absence for every OM adapter method. They are not feature acceptance. j05 replaces them with shared behavior suites for memory and real adapters. No vendor API, live spend or migration runs in j00.
