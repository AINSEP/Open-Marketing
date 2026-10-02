import type { ClockPort, IdPort } from "@open-marketing/contracts";
import type { MediaLibrary, PlacementCropPreset } from "./types.js";
import { notImplemented } from "@open-marketing/contracts";
import type { MediaRepoPort, JiniMediaPort, BlobStorePort, GuardedAssetImportPort, ImageTransformPort, MediaAuditPort, MediaObserverPort } from "./ports.js";
/** Inert media-library factory. @returns Service whose operations fail with typed not_implemented; no I/O or startup. @example createMediaLibrary({ injectedPorts: undefined } as Parameters<typeof createMediaLibrary>[0]) @complexity O(1). */
export function createMediaLibrary(
  required: {
    repo: MediaRepoPort;
    media: JiniMediaPort;
    blobs: BlobStorePort;
    importer: GuardedAssetImportPort;
    transforms: ImageTransformPort;
    clock: ClockPort;
    ids: IdPort;
    audit: MediaAuditPort;
  },
  optional?: { observer?: MediaObserverPort; placementPresets?: readonly PlacementCropPreset[] },
): MediaLibrary {
return {
 async importAsset() { return notImplemented({ operation: "media-library.importAsset" }); },
 async createCrop() { return notImplemented({ operation: "media-library.createCrop" }); },
 async list() { return notImplemented({ operation: "media-library.list" }); },
 async recordProvenance() { return notImplemented({ operation: "media-library.recordProvenance" }); },
 async recordCost() { return notImplemented({ operation: "media-library.recordCost" }); },
};
}
