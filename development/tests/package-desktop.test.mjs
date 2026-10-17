import { it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, renameSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { desktopBuildOptions, stageTransitiveDependencies } from '../scripts/package-desktop.mjs';

it('disables builder dependency collection and explicitly includes staged shell dependencies', async () => {
 const { config, publish } = desktopBuildOptions({ desktop: '/fixture/apps/desktop' });
 expect(publish).toBe('never');
 expect(config.npmRebuild).toBe(true);
 expect(await config.beforeBuild()).toBe(false);
 expect(config.directories.app).toBe('staging/app');
 expect(config.files).toContainEqual({ from: 'node_modules/zod', to: 'node_modules/zod', filter: ['**/*'] });
 expect(config.extraResources).toEqual(expect.arrayContaining([
  { from: 'staging/om/apps/server/node_modules', to: 'om/apps/server/node_modules', filter: ['**/*'] },
  { from: 'staging/om/apps/agent/node_modules', to: 'om/apps/agent/node_modules', filter: ['**/*'] },
 ]));
});

function fixturePackage({ directory, name, version = '1.0.0', dependencies = {}, code = 'module.exports = "fixture";' }) {
 mkdirSync(directory, { recursive: true });
 writeFileSync(join(directory, 'package.json'), JSON.stringify({ name, version, main: 'index.js', dependencies }));
 writeFileSync(join(directory, 'index.js'), code);
}

it('hoists the first version, nests the conflicting version, and resolves both after relocation', () => {
 const root = mkdtempSync(join(tmpdir(), 'om-packaging-'));
 try {
  const source = join(root, 'source');
  const outDir = join(root, 'staged');
  fixturePackage({ directory: source, name: 'server', dependencies: { zod: '4.1.13', consumer: '1.0.0' } });
  fixturePackage({ directory: join(source, 'node_modules/zod'), name: 'zod', version: '4.1.13', code: 'module.exports = "zod4";' });
  fixturePackage({ directory: join(source, 'node_modules/consumer'), name: 'consumer', dependencies: { zod: '3.25.76' }, code: 'module.exports = require("zod");' });
  fixturePackage({ directory: join(source, 'node_modules/consumer/node_modules/zod'), name: 'zod', version: '3.25.76', code: 'module.exports = "zod3";' });
  stageTransitiveDependencies({ source, outDir });
  const relocated = join(root, 'relocated');
  renameSync(outDir, relocated);
  rmSync(source, { recursive: true });
  const require = createRequire(join(relocated, 'entry.cjs'));
  expect(require('zod')).toBe('zod4');
  expect(require('consumer')).toBe('zod3');
  const nested = JSON.parse(readFileSync(join(relocated, 'node_modules/consumer/node_modules/zod/package.json'), 'utf8'));
  expect(nested.version).toBe('3.25.76');
 } finally { rmSync(root, { recursive: true, force: true }); }
});

it('throws with the dependent and missing production package', () => {
 const root = mkdtempSync(join(tmpdir(), 'om-packaging-'));
 try {
  const source = join(root, 'source');
  fixturePackage({ directory: source, name: 'server', dependencies: { 'om-fixture-missing-production-dep': '1.0.0' } });
  expect(() => stageTransitiveDependencies({ source, outDir: join(root, 'staged') })).toThrow('Unresolved production dependency: server -> om-fixture-missing-production-dep');
 } finally { rmSync(root, { recursive: true, force: true }); }
});
