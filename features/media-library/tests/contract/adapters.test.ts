import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalFsBlobStore } from '@jini-ai/cms/media';
import { describe } from 'vitest';
import { createJiniBlobStore, createJiniMediaAdapter, createJiniImageTransform, createSqlMediaRepo } from '../../index.js';
import { sqlFixture } from '../sql-fixture.js';
import { MediaRepoPortSuite, BlobStorePortSuite, JiniMediaPortSuite, ImageTransformPortSuite } from './port-suites.js';
import { context, dependencies } from '../fixtures.js';

describe('Injected adapters', () => {
  MediaRepoPortSuite({ create: async () => {
    const fixture = await sqlFixture();
    return { port: createSqlMediaRepo({ db: fixture.db, scope: context.scope }), dispose: fixture.dispose };
  } });
  BlobStorePortSuite({ create: async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'om-media-contract-'));
    return { port: createJiniBlobStore({ scope: context.scope, store: new LocalFsBlobStore({ rootDir }) }), dispose: async () => { await rm(rootDir, { recursive: true, force: true }); } };
  } });
  JiniMediaPortSuite({ create: () => {
    const deps = dependencies();
    return { deps, port: createJiniMediaAdapter({ scope: context.scope, dependencies: deps }) };
  } });
  ImageTransformPortSuite({ create: () => {
    const deps = dependencies();
    return { deps, port: createJiniImageTransform({ scope: context.scope, dependencies: deps }) };
  } });
});
