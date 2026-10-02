import { notImplemented } from '@open-marketing/contracts';
import type { MediaRepoPort, JiniMediaPort, BlobStorePort, GuardedAssetImportPort, ImageTransformPort, MediaAuditPort } from './ports.js';
/** Inert OM adapter stub for MediaRepoPort; no storage or upstream implementation claim. */
export function createMemoryMediaRepo(required: Record<string, never>): MediaRepoPort { return {
 async saveCrop() { return notImplemented({ operation: "MediaRepoPort.saveCrop" }); },
 async appendProvenance() { return notImplemented({ operation: "MediaRepoPort.appendProvenance" }); },
 async appendCost() { return notImplemented({ operation: "MediaRepoPort.appendCost" }); },
 async evidence() { return notImplemented({ operation: "MediaRepoPort.evidence" }); },
}; }
/** Inert OM adapter stub for JiniMediaPort; no storage or upstream implementation claim. */
export function createMemoryJiniMedia(required: Record<string, never>): JiniMediaPort { return {
 async save() { return notImplemented({ operation: "JiniMediaPort.save" }); },
 async get() { return notImplemented({ operation: "JiniMediaPort.get" }); },
 async findByDigest() { return notImplemented({ operation: "JiniMediaPort.findByDigest" }); },
 async list() { return notImplemented({ operation: "JiniMediaPort.list" }); },
}; }
/** Inert OM adapter stub for BlobStorePort; no storage or upstream implementation claim. */
export function createMemoryBlobStore(required: Record<string, never>): BlobStorePort { return {
 async put() { return notImplemented({ operation: "BlobStorePort.put" }); },
 async read() { return notImplemented({ operation: "BlobStorePort.read" }); },
 async remove() { return notImplemented({ operation: "BlobStorePort.remove" }); },
}; }
/** Inert OM adapter stub for GuardedAssetImportPort; no storage or upstream implementation claim. */
export function createMemoryGuardedAssetImport(required: Record<string, never>): GuardedAssetImportPort { return {
 async import() { return notImplemented({ operation: "GuardedAssetImportPort.import" }); },
}; }
/** Inert OM adapter stub for ImageTransformPort; no storage or upstream implementation claim. */
export function createMemoryImageTransform(required: Record<string, never>): ImageTransformPort { return {
 async crop() { return notImplemented({ operation: "ImageTransformPort.crop" }); },
}; }
/** Inert OM adapter stub for MediaAuditPort; no storage or upstream implementation claim. */
export function createMemoryMediaAudit(required: Record<string, never>): MediaAuditPort { return {
 async record() { return notImplemented({ operation: "MediaAuditPort.record" }); },
}; }
