import type { MediaRecord, AssetBlobRecord, AssetRenditionRecord, TransformParams } from '@jini-ai/cms/media';
import type { Outcome, CallContext, CallOptions, Money, Page, PageQuery } from '@open-marketing/contracts';

/** Jini owns the canonical record and bytes; OM attaches append-only marketing evidence. */
export type Asset = { readonly record: MediaRecord; readonly blob: AssetBlobRecord; readonly provenance: AssetProvenance | null };
/** Evidence is required for imports, including uploads without a generation prompt. */
export type AssetProvenance = {
    readonly operationId: string;
    readonly source: string;
    readonly prompt: string | null;
    readonly model: string | null;
    readonly seed: number | null;
    readonly cost: Money | null;
    readonly vendorTerms: { readonly url: string; readonly digest: string; readonly observedAt: number } | null;
    readonly rights: { readonly evidenceId: string; readonly license: string; readonly permittedUses: readonly string[] };
    readonly generationId?: string;
    readonly quoteId?: string;
    readonly providerJobId?: string;
    readonly reservationId?: string;
};
/** URL import is supplied by the Jini import adapter when its public export is published. */
export type AssetImportRequest = { readonly sourceUrl: string; readonly operationId: string; readonly expectedDigest: string; readonly provenance: AssetProvenance };
/** Estimated, observed and linked corrective costs survive absent or delayed output. */
export type AssetCost = { readonly observationId: string; readonly operationId: string; readonly amount: Money; readonly kind: 'estimated' | 'actual' | 'correction'; readonly correctionOf?: string };
/** Named, versioned Jini transforms supply non-destructive placement crops. */
export type PlacementCropPreset = { readonly placement: string; readonly version: number; readonly params: Readonly<TransformParams> };
/** Caller selects a registered preset rather than sending arbitrary transform parameters. */
export type PlacementCropRequest = { readonly assetId: string; readonly placement: string; readonly presetVersion: number };
/** Jini owns rendition bytes/metadata; OM owns the placement link. */
export type PlacementCrop = PlacementCropRequest & { readonly cropId: string; readonly rendition: AssetRenditionRecord };
/** Bounded OM pagination over Jini workspace-scoped assets. */
export type AssetQuery = PageQuery;
export type AssetPage = Page<Asset>;
/** Content-addressed Jini storage identity, never an independently invented OM blob ID. */
export type BlobReference = Pick<AssetBlobRecord, 'workspaceId' | 'sha256' | 'storageKey'>;
/** Guarded URL ingestion returns the canonical Jini asset, not a parallel asset record. */
export type ImportedAsset = Asset;
/** Append-only evidence may exist before an asset, or after failed generation. */
export type ProvenanceLink = { readonly provenance: AssetProvenance; readonly assetId?: string };
/** Thin OM orchestration: evidence/cost/placement policy over public Jini media operations. */
export interface MediaLibrary {
    importAsset(required: { context: CallContext; request: AssetImportRequest }, optional?: CallOptions): Promise<Outcome<Asset>>;
    createCrop(required: { context: CallContext; request: PlacementCropRequest }, optional?: CallOptions): Promise<Outcome<PlacementCrop>>;
    list(required: { context: CallContext; query: AssetQuery }, optional?: CallOptions): Promise<Outcome<AssetPage>>;
    recordProvenance(required: { context: CallContext; link: ProvenanceLink }, optional?: CallOptions): Promise<Outcome<void>>;
    recordCost(required: { context: CallContext; cost: AssetCost }, optional?: CallOptions): Promise<Outcome<void>>;
}
