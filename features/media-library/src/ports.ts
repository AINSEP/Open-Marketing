import type { UploadMediaDeps, ResolveMediaRenditionDeps, PutBlobInput, BlobStorePort as JiniBlobStorePort } from '@jini-ai/cms/media';
import type { Outcome, CallContext, CallOptions, ObserverPort } from '@open-marketing/contracts';
import type { Asset, AssetCost, AssetImportRequest, AssetQuery, AssetPage, ImportedAsset, PlacementCropRequest, PlacementCrop, ProvenanceLink, ImageInspection } from './types.js';

/** Public upstream dependencies for the feature adapter; no Jini internals or driver types. */
export type JiniMediaDependencies = UploadMediaDeps & ResolveMediaRenditionDeps;
/** OM-owned append-only marketing metadata only. Canonical assets/blobs are owned by Jini. */
export interface MediaRepoPort {
    saveCrop(required: { context: CallContext; crop: PlacementCrop }, optional?: CallOptions): Promise<Outcome<PlacementCrop>>;
    appendProvenance(required: { context: CallContext; link: ProvenanceLink }, optional?: CallOptions): Promise<Outcome<void>>;
    appendCost(required: { context: CallContext; cost: AssetCost }, optional?: CallOptions): Promise<Outcome<void>>;
    evidence(required: { context: CallContext; operationId: string }, optional?: CallOptions): Promise<Outcome<{ provenance: readonly ProvenanceLink[]; costs: readonly AssetCost[] }>>;
}
/** OM Outcome/scope adapter over public Jini media services and repositories. No duplicate asset store. */
export interface JiniMediaPort {
    save(required: { context: CallContext; asset: Asset }, optional?: CallOptions): Promise<Outcome<Asset>>;
    get(required: { context: CallContext; assetId: string }, optional?: CallOptions): Promise<Outcome<Asset>>;
    findByDigest(required: { context: CallContext; contentDigest: string }, optional?: CallOptions): Promise<Outcome<Asset | null>>;
    list(required: { context: CallContext; query: AssetQuery }, optional?: CallOptions): Promise<Outcome<AssetPage>>;
}
/** Scope/error wrapper around Jini's content-addressed blob store; adapters reuse its putIfAbsent. */
export interface BlobStorePort {
    put(required: { context: CallContext; input: PutBlobInput }, optional?: CallOptions): Promise<Outcome<Awaited<ReturnType<JiniBlobStorePort['putIfAbsent']>>>>;
    read(required: { context: CallContext; storageKey: string }, optional?: CallOptions): Promise<Outcome<Uint8Array>>;
    remove(required: { context: CallContext; storageKey: string }, optional?: CallOptions): Promise<Outcome<void>>;
}
/** Guarded Jini URL import adapter: host guard owns DNS/peer/redirect policy; OM validates bytes and decoded dimensions. */
export interface GuardedAssetImportPort {
    import(required: { context: CallContext; request: AssetImportRequest }, optional?: CallOptions): Promise<Outcome<ImportedAsset>>;
}
/** Adapter to Jini registerTransform/resolveMediaRendition, using injected placement presets. */
export interface ImageTransformPort {
    crop(required: { context: CallContext; request: PlacementCropRequest }, optional?: CallOptions): Promise<Outcome<PlacementCrop>>;
}
/** Inject a bounded full decode/inspection. Jini 0.5.6's transformer does not expose this metadata.
 * The host must honor maxPixels before allocating decoded buffers and bound execution time.
 * @example inspection.inspect({ context, bytes, contentType: 'image/png', maxPixels: 40000000 })
 */
export interface ImageInspectionPort {
    inspect(required: { context: CallContext; bytes: Uint8Array; contentType: string; maxPixels: number }, optional?: CallOptions): Promise<Outcome<ImageInspection>>;
}
/** Idempotent marketing audit append; never grants generation or tool authority. */
export interface MediaAuditPort {
    record(required: { context: CallContext; operationId: string; assetId: string }, optional?: CallOptions): Promise<Outcome<void>>;
}
export type MediaObserverPort = ObserverPort;
