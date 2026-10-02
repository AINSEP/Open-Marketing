import { it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { outputIntegrity } from '../scripts/output-integrity.mjs';
import { workspacePackages, sourceFiles } from '../scripts/workspace.mjs';
import { sourceDigest } from '../scripts/source-digest.mjs';
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
