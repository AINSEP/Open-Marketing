import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { graphCycles, edgeViolations, importSpecifiers, checkBoundaries, nonliteralImportAllowed } from '../scripts/boundaries.mjs';
import { workspacePackages } from '../scripts/workspace.mjs';
import ts from 'typescript';
const packages = [
 { name: '@open-marketing/policy', path: 'features/policy', om: { kind: 'feature' } },
 { name: '@open-marketing/safety', path: 'features/safety', om: { kind: 'feature' } },
 { name: '@open-marketing/jobs', path: 'features/jobs', om: { kind: 'feature' } },
];
describe('boundary conformance', () => {
 it.each([2,3])('%s-node cycle fails', count => { const edges = Array.from({ length: count }, (_, index) => ({ from: String(index), to: String((index+1)%count) })); expect(graphCycles({ edges }).length).toBeGreaterThan(0); });
 it('cycle through unchanged source fails', () => expect(graphCycles({ edges: [{ from: 'changed', to: 'unchanged' },{ from: 'unchanged', to: 'changed' }] }).length).toBeGreaterThan(0));
 it('acyclic high fanout passes', () => expect(graphCycles({ edges: Array.from({ length: 100 }, (_, index) => ({ from: 'root', to: String(index) })) })).toEqual([]));
 it.each(['@open-marketing/policy/src/gates','../../features/policy/index.ts','@alias/policy'])('feature spelling %s fails', specifier => expect(edgeViolations({ from: 'apps/server/src/composition/index.ts', to: 'features/policy/index.ts', specifier, packages })).toContain('feature-public-name'));
 it('only the server executable boundary may load plugin code by computed URL', () => {
  expect(nonliteralImportAllowed({ file: 'apps/server/src/composition/serve.ts' })).toBe(true);
  for (const file of ['apps/server/src/composition/index.ts', 'apps/server/src/composition/addons.ts', 'features/jobs/src/service.ts', 'apps/agent/src/composition/serve.ts']) expect(nonliteralImportAllowed({ file })).toBe(false);
 });
 it('type-only spellings and require/dynamic/reexport are captured', () => { for (const source of ['import type { A } from "bad";', 'export { A } from "bad";', 'require("bad");', 'import("bad");', 'type A = import("bad").A;']) expect(importSpecifiers({ source, file: 'test.ts' })[0].specifier).toBe('bad'); });
 it('default feature edges fail and pure policy exception is narrow', () => { expect(edgeViolations({ from: 'features/jobs/src/service.ts', to: 'features/policy/index.ts', specifier: '@open-marketing/policy', packages })).toContain('feature-to-feature'); expect(edgeViolations({ from: 'features/safety/src/service.ts', to: 'features/policy/index.ts', specifier: '@open-marketing/policy', packages })).toEqual([]); });
 it('policy service, wildcard and memory adapter imports cannot use the pure-gate exception', () => {
  for (const name of ['createPolicyService','createMemoryPolicyRepo','*']) expect(edgeViolations({ from: 'features/safety/src/service.ts', to: 'features/policy/index.ts', specifier: '@open-marketing/policy', names: [name], packages })).toContain('policy-pure-gates-only');
 });
 it.each(['features/policy/index.ts','content/agent-plugins/plugin/index.ts','apps/server/src/index.ts'])('agent backend edge %s fails', to => expect(edgeViolations({ from: 'apps/agent/src/index.ts', to, specifier: '@open-marketing/policy', packages })).toContain('client-to-backend'));
 it.each(['apps/studio/src/pages/other/ui.tsx','apps/studio/src/features/other/index.ts'])('FSD forbidden edge %s fails', to => expect(edgeViolations({ from: 'apps/studio/src/features/current/ui.tsx', to, specifier: '../other', packages })).toContain('fsd-edge'));
 it.each(['development/parked/render/src/index.ts','features/jobs/tests/helper.ts'])('production edge %s fails', to => expect(edgeViolations({ from: 'apps/server/src/index.ts', to, specifier: './helper', packages })).toContain('production-to-nonproduction'));
 it('sibling relative source fails', () => expect(edgeViolations({ from: 'apps/server/src/index.ts', to: '../Jini/src/index.ts', specifier: '../../../Jini/src/index.ts', packages })).toContain('sibling-source'));
 it('relocation changes one glob and leaves consumer spelling/graph unchanged', async () => {
  const root = mkdtempSync(join(tmpdir(),'om-relocate-'));
  try {
   for (const folder of ['features/sample','apps/consumer/src/composition']) mkdirSync(join(root,folder), { recursive: true });
   writeFileSync(join(root,'pnpm-workspace.yaml'),'packages:\n  - features/*\n  - apps/*\n');
   writeFileSync(join(root,'features/sample/package.json'),JSON.stringify({ name: '@open-marketing/sample', om: { kind: 'feature' }, exports: { '.': { types: './index.ts' } } }));
   writeFileSync(join(root,'features/sample/index.ts'),'export const sample = 1;');
   writeFileSync(join(root,'apps/consumer/package.json'),JSON.stringify({ name: '@open-marketing/consumer', om: { kind: 'app', composition: 'src/composition/index.ts' }, dependencies: { '@open-marketing/sample': 'workspace:*' } }));
   writeFileSync(join(root,'apps/consumer/src/composition/index.ts'),'import { sample } from "@open-marketing/sample"; export { sample };');
   expect((await checkBoundaries({ root })).failures).toEqual([]);
   expect(consumerTypecheck({ root })).toEqual([]);
   const { renameSync } = await import('node:fs'); renameSync(join(root,'features'),join(root,'modules'));
   writeFileSync(join(root,'pnpm-workspace.yaml'),'packages:\n  - modules/*\n  - apps/*\n');
   expect((await checkBoundaries({ root })).failures).toEqual([]);
   expect(consumerTypecheck({ root })).toEqual([]);
  } finally { rmSync(root,{ recursive: true, force: true }); }
 });
});
/** Recreate workspace links from manifest discovery, as a fresh pnpm install does after relocation. */
function consumerTypecheck(required: { root: string }) {
 const folder = join(required.root,'apps/consumer/node_modules/@open-marketing');
 rmSync(folder,{ recursive: true, force: true }); mkdirSync(folder,{ recursive: true });
 const feature = workspacePackages({ root: required.root }).find(pkg => pkg.om?.kind === 'feature');
 symlinkSync(feature.absolute,join(folder,feature.name.split('/')[1]),'dir');
 const program = ts.createProgram([join(required.root,'apps/consumer/src/composition/index.ts')],{ strict: true, noEmit: true, skipLibCheck: true, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext });
 return ts.getPreEmitDiagnostics(program);
}
/** Real temporary files prove full graph collection; unchanged/type-only source is not reduced to touched files. */
it('dependency-cruiser and original-source graph reject a real type-only cycle', async () => {
 const root = mkdtempSync(join(tmpdir(),'om-cycle-'));
 try {
  mkdirSync(join(root,'packages/sample'),{ recursive: true });
  writeFileSync(join(root,'pnpm-workspace.yaml'),'packages:\n  - packages/*\n');
  writeFileSync(join(root,'packages/sample/package.json'),JSON.stringify({ name: '@sample/core' }));
  writeFileSync(join(root,'packages/sample/a.ts'),'import type { B } from "./b.js"; export type A = { b: B };');
  writeFileSync(join(root,'packages/sample/b.ts'),'import type { C } from "./unchanged.js"; export type B = { c: C };');
  writeFileSync(join(root,'packages/sample/unchanged.ts'),'import type { A } from "./a.js"; export type C = { a: A };');
  const result = await checkBoundaries({ root });
  expect(result.failures.some(failure => failure.includes('cycle:'))).toBe(true);
  expect(result.failures.some(failure => failure.includes('dependency-cruiser'))).toBe(true);
 } finally { rmSync(root,{ recursive: true, force: true }); }
});
it.each(['file:../Jini','link:../Tovu','workspace:*'])('sibling declaration %s fails', async version => {
 const root = mkdtempSync(join(tmpdir(),'om-sibling-'));
 try {
  mkdirSync(join(root,'packages/sample'),{ recursive: true });
  writeFileSync(join(root,'pnpm-workspace.yaml'),'packages:\n  - packages/*\n');
  writeFileSync(join(root,'packages/sample/package.json'),JSON.stringify({ name: '@sample/core', dependencies: { '@jini-ai/private-source': version } }));
  writeFileSync(join(root,'packages/sample/index.ts'),'export const inert = 1;');
  expect((await checkBoundaries({ root })).failures.length).toBeGreaterThan(0);
 } finally { rmSync(root,{ recursive: true, force: true }); }
});
it('configured alias and type-only relative feature access fail the real checker', async () => {
 const root = mkdtempSync(join(tmpdir(),'om-alias-'));
 try {
  for (const folder of ['features/sample','apps/consumer/src/composition']) mkdirSync(join(root,folder),{ recursive: true });
  writeFileSync(join(root,'pnpm-workspace.yaml'),'packages:\n  - features/*\n  - apps/*\n');
  writeFileSync(join(root,'features/sample/package.json'),JSON.stringify({ name: '@open-marketing/sample', om: { kind: 'feature' }, exports: { '.': { types: './index.ts' } } }));
  writeFileSync(join(root,'features/sample/index.ts'),'export interface Sample { value: number }');
  writeFileSync(join(root,'apps/consumer/package.json'),JSON.stringify({ name: '@open-marketing/consumer', om: { kind: 'app', composition: 'src/composition/index.ts' } }));
  writeFileSync(join(root,'apps/consumer/tsconfig.json'),JSON.stringify({ compilerOptions: { baseUrl: '../..', paths: { '@alias/*': ['features/*/index.ts'] } } }));
  writeFileSync(join(root,'apps/consumer/src/composition/index.ts'),'import type { Sample } from "@alias/sample"; export type Value = Sample;');
  expect((await checkBoundaries({ root })).failures.some(failure => failure.includes('feature-public-name'))).toBe(true);
 } finally { rmSync(root,{ recursive: true, force: true }); }
});
