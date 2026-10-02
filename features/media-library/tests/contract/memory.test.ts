import { describe } from 'vitest';
import { MediaRepoPortSuite, JiniMediaPortSuite, BlobStorePortSuite, GuardedAssetImportPortSuite, ImageTransformPortSuite, MediaAuditPortSuite } from './port-suites.js';
import { createMemoryMediaRepo, createMemoryJiniMedia, createMemoryBlobStore, createMemoryGuardedAssetImport, createMemoryImageTransform, createMemoryMediaAudit } from '../../index.js';
import { context, dependencies } from '../fixtures.js';
describe('Memory adapters', () => {
  MediaRepoPortSuite({ create: () => ({ port: createMemoryMediaRepo({ scope: context.scope }) }) });
  BlobStorePortSuite({ create: () => ({ port: createMemoryBlobStore({ scope: context.scope }) }) });
  GuardedAssetImportPortSuite({ create: () => createMemoryGuardedAssetImport({ scope: context.scope }) });
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
