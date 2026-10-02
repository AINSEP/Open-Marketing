import { MediaRepoPortSuite, JiniMediaPortSuite, BlobStorePortSuite, GuardedAssetImportPortSuite, ImageTransformPortSuite, MediaAuditPortSuite } from "./port-suites.js";
import { createMemoryMediaRepo, createMemoryJiniMedia, createMemoryBlobStore, createMemoryGuardedAssetImport, createMemoryImageTransform, createMemoryMediaAudit } from "../../index.js";
MediaRepoPortSuite({ create: () => createMemoryMediaRepo({}) });
BlobStorePortSuite({ create: () => createMemoryBlobStore({}) });
GuardedAssetImportPortSuite({ create: () => createMemoryGuardedAssetImport({}) });
ImageTransformPortSuite({ create: () => createMemoryImageTransform({}) });
MediaAuditPortSuite({ create: () => createMemoryMediaAudit({}) });
JiniMediaPortSuite({ create: () => createMemoryJiniMedia({}) });
