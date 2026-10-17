import { it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { outputIntegrity } from '../scripts/output-integrity.mjs';
import { workspacePackages, sourceFiles } from '../scripts/workspace.mjs';
import { sourceDigest } from '../scripts/source-digest.mjs';
import { lintSources } from '../scripts/lint.mjs';
import { ESLint } from 'eslint';
it('generated exclusions require current source and output integrity; scratch source stays owned', () => {
 const root = mkdtempSync(join(tmpdir(),'om-integrity-'));
 try {
  mkdirSync(join(root,'packages/sample/dist'),{ recursive: true }); mkdirSync(join(root,'.tmp'),{ recursive: true });
  writeFileSync(join(root,'pnpm-workspace.yaml'),'packages:\n  - packages/*\n');
  writeFileSync(join(root,'packages/sample/package.json'),JSON.stringify({ name: '@sample/core' }));
  writeFileSync(join(root,'packages/sample/index.ts'),'export const value = 1;');
  writeFileSync(join(root,'packages/sample/dist/index.js'),'export const value = 1;');
  writeFileSync(join(root,'.tmp/hidden.mjs'),'export const hidden = 1;');
  expect(sourceFiles({ root })).toContain('.tmp/hidden.mjs');
  expect(outputIntegrity({ root })[0]).toContain('missing generated integrity receipt');
  const owner = workspacePackages({ root })[0];
  writeFileSync(join(root,'packages/sample/dist/.om-generated.json'),JSON.stringify({ owner: owner.name, sourceDigest: sourceDigest({ root, owner }), toolchain: 'Node24.2.0-pnpm10.24.0', outputs: { 'packages/sample/dist/index.js': createHash('sha256').update('export const value = 1;').digest('hex') } }));
  expect(outputIntegrity({ root })).toEqual([]);
  writeFileSync(join(root,'packages/sample/index.ts'),'export const value = 2;');
  expect(outputIntegrity({ root })[0]).toContain('source provenance');
  writeFileSync(join(root,'packages/sample/dist/index.js'),'export const value = 999;');
  expect(outputIntegrity({ root })[0]).toContain('checksum mismatch');
 } finally { rmSync(root,{ recursive: true, force: true }); }
});

it('exempts only verified versioned plugin client bundles and still lints first-party source', async () => {
 const root = mkdtempSync(join(tmpdir(), 'om-plugin-client-'));
 const bundle = 'content/plugins/example/1.0.0/client/provider.js';
 const source = 'export function bad(required: string) { return required; }';
 const firstParty = ['apps/studio/src/example.ts', 'features/example/index.ts', '.tmp/parked.js',
  'content/plugins/example/1.0.0/server/index.mjs', 'content/plugins/example/1.0.0/client/first-party.ts',
  'content/plugins/unversioned/client/provider.js', 'content/agent-plugins/example/client/provider.js'];
 try {
  for (const file of [bundle, ...firstParty]) {
   mkdirSync(join(root, file, '..'), { recursive: true });
   writeFileSync(join(root, file), file.endsWith('.ts') ? source : 'export const value = 1;');
  }
  const manifest = join(root, 'content/plugins/example/1.0.0/jini.plugin.json');
  writeFileSync(manifest, JSON.stringify({ integrity: { 'client/provider.js': 'sha256-' + createHash('sha256').update('export const value = 1;').digest('hex') } }));
  const checked = lintSources({ root });
  expect(checked.failures).toEqual([]);
  expect(checked.files).not.toContain(bundle);
  expect(checked.files).toEqual(expect.arrayContaining(firstParty));
  const eslint = new ESLint();
  for (const file of ['apps/studio/src/example.ts', 'features/example/index.ts']) {
   const config = await eslint.calculateConfigForFile(file);
   expect(config?.rules?.['sonarjs/cognitive-complexity']).toEqual([2, 10]);
   expect(config?.rules?.['max-depth']).toEqual([2, 3]);
   expect((await eslint.lintText(source, { filePath: file }))[0].messages.some(message => message.ruleId === 'om/two-object-arguments')).toBe(true);
  }
  writeFileSync(join(root, bundle), 'tampered');
  expect(lintSources({ root }).failures).toEqual([bundle + ': missing or corrupt plugin client integrity']);
  expect(lintSources({ root }).files).toContain(bundle);
  writeFileSync(manifest, '{}');
  expect(lintSources({ root }).failures).toHaveLength(1);
 } finally { rmSync(root, { recursive: true, force: true }); }
}, 30000);

it('exempts exactly the non-workspace agent-plugin esbuild entry while retaining all adjacent gates', () => {
 const root = mkdtempSync(join(tmpdir(), 'om-agent-plugin-output-'));
 const allowed = 'content/agent-plugins/fixture/io.github.ainsep.openmarketing/dist/index.mjs';
 const guarded = [
  'content/agent-plugins/fixture/io.github.ainsep.openmarketing/dist/other.mjs',
  'content/agent-plugins/fixture/io.github.ainsep.openmarketing/dist/index.js',
  'content/agent-plugins/fixture/dist/index.mjs',
  'content/plugins/fixture/io.github.ainsep.openmarketing/dist/index.mjs',
  'apps/server/dist/index.mjs',
 ];
 try {
  writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages: []\n');
  for (const file of [allowed, ...guarded]) {
   mkdirSync(join(root, file, '..'), { recursive: true });
   writeFileSync(join(root, file), 'export const built = true;');
  }
  const failures = outputIntegrity({ root });
  expect(failures).toHaveLength(guarded.length);
  for (const file of guarded) expect(failures).toContain(file + ': missing generated integrity receipt');
  expect(sourceFiles({ root })).not.toContain(allowed);
  const source = 'content/agent-plugins/fixture/io.github.ainsep.openmarketing/src/index.ts';
  mkdirSync(join(root, source, '..'), { recursive: true });
  writeFileSync(join(root, source), 'export const source = true;');
  expect(lintSources({ root }).files).toContain(source);
 } finally { rmSync(root, { recursive: true, force: true }); }
});
