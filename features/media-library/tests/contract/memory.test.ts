import { describe } from 'vitest';
import { MediaRepoPortSuite, JiniMediaPortSuite, BlobStorePortSuite, GuardedAssetImportPortSuite, ImageTransformPortSuite, ImageInspectionPortSuite, MediaAuditPortSuite } from './port-suites.js';
import { createMemoryMediaRepo, createMemoryJiniMedia, createMemoryBlobStore, createMemoryGuardedAssetImport, createMemoryImageTransform, createMemoryImageInspection, createMemoryMediaAudit } from '../../index.js';
import { bytes, context, dependencies } from '../fixtures.js';
describe('Memory adapters', () => {
  MediaRepoPortSuite({ create: () => ({ port: createMemoryMediaRepo({ scope: context.scope }) }) });
  BlobStorePortSuite({ create: () => ({ port: createMemoryBlobStore({ scope: context.scope }) }) });
  GuardedAssetImportPortSuite({ create: () => {
    const deps = dependencies();
    return { deps, port: createMemoryGuardedAssetImport({ scope: context.scope, dependencies: deps, fixtures: [{ sourceUrl: 'https://example.com/image.png', bytes, image: { width: 1, height: 1, frames: 1 } }] }) };
  } });
  ImageInspectionPortSuite({ create: () => createMemoryImageInspection({ scope: context.scope, fixtures: [{ bytes, contentType: 'image/png', image: { width: 7, height: 9, frames: 1 } }] }) });
  ImageTransformPortSuite({ create: () => {
    const deps = dependencies();
    return { deps, port: createMemoryImageTransform({ scope: context.scope, dependencies: deps }) };
  } });
  MediaAuditPortSuite({ create: () => ({ port: createMemoryMediaAudit({ scope: context.scope }) }) });
  JiniMediaPortSuite({ create: () => {
    const deps = dependencies();
    return { deps, port: createMemoryJiniMedia({ scope: context.scope, dependencies: deps }) };
  } });
});
