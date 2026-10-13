import { describe, it, expect } from 'vitest';
import { ESLint } from 'eslint';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { sourceIntegrity } from '../scripts/lint.mjs';
import { measureSource } from '../scripts/metrics.mjs';
const eslint = new ESLint();
it.each(['ts', 'mts', 'cts'])('integrity and metrics parse generic arrows in .%s without JSX', extension => {
 const source = 'const identity = <T>(required: { value: T }): T => required.value;';
 const file = `virtual.${extension}`;
 expect(sourceIntegrity({ source, file })).toBe(false);
 expect(measureSource({ source, file })).toMatchObject([{ cyclomatic: 1 }]);
 expect(sourceIntegrity({ source: '/* eslint-disable */\n' + source, file })).toBe(true);
});
it.each(['tsx', 'jsx'])('integrity and metrics retain JSX parsing in .%s', extension => {
 const source = 'const View = () => <div />;';
 const file = `virtual.${extension}`;
 expect(sourceIntegrity({ source, file })).toBe(false);
 expect(measureSource({ source, file })).toMatchObject([{ cyclomatic: 1 }]);
});
/** Real ESLint invocation over inert fixture programs, never an ignored executable violation. */
async function fixture(required: { name: string; extension?: string }) {
 const source = readFileSync(`development/fixtures/lint/${required.name}.txt`, 'utf8');
 const result = await eslint.lintText(source, { filePath: `development/fixtures/virtual.${required.extension ?? 'ts'}` });
 return { source, messages: result[0].messages };
}
describe('OM lint conformance', () => {
 it.each(['ts','tsx','mts','cts','js','jsx','mjs','cjs'])('resolves error gates for %s', async extension => {
  const config = await eslint.calculateConfigForFile(`development/fixtures/virtual.${extension}`);
  expect(config?.rules?.['sonarjs/cognitive-complexity']).toEqual([2,10]);
  expect(config?.rules?.['max-depth']).toEqual([2,3]);
  for (const rule of ['om/control-depth','om/two-object-arguments','om/no-functions-in-component-body']) expect(config?.rules?.[rule]).toEqual([2]);
  expect(config?.rules?.complexity?.[0]).toBe(0);
  expect(config?.linterOptions?.noInlineConfig).toBe(true);
 });
 it('signature-positive passes', async () => expect((await fixture({ name: 'signature-positive' })).messages).toEqual([]), 30000);
 it.each(['cognitive-10','nesting-3','foreign-callback','switch-14'])('%s passes', async name => expect((await fixture({ name })).messages).toEqual([]));
 it('guard clauses are a nesting negative control', async () => {
  const result = await fixture({ name: 'guard-clauses' }); expect(result.messages).toEqual([]);
  expect(measureSource({ source: result.source, file: 'virtual.ts' })[0].nesting).toBe(1);
 });
 it.each(['cognitive-11','nesting-4','signature-scalar','signature-three','owned-callback'])('%s fails', async name => expect((await fixture({ name })).messages.some(message => message.severity === 2)).toBe(true));
 it.each(['nested-declaration','nested-expression','nested-arrow','jsx-arrow','effect-callback'])('%s fails TSX rule', async name => expect((await fixture({ name, extension: 'tsx' })).messages.some(message => message.ruleId === 'om/no-functions-in-component-body')).toBe(true));
 it('inline controls fail integrity and cannot disable errors', async () => {
  const result = await fixture({ name: 'inline-disable' }); expect(sourceIntegrity({ source: result.source })).toBe(true);
 });
 it('exhaustive 14-arm switch compiles and emits cyclomatic magnitude without gating it', async () => {
  const { source } = await fixture({ name: 'switch-14' });
  const host = ts.createCompilerHost({ strict: true, noEmit: true, skipLibCheck: true }); const original = host.getSourceFile;
  host.getSourceFile = (file, languageVersion, onError, create) => file === '/virtual/fixture.ts' ? ts.createSourceFile(file, source, languageVersion, true) : original(file, languageVersion, onError, create);
  const program = ts.createProgram(['/virtual/fixture.ts'], { strict: true, noEmit: true, skipLibCheck: true }, host);
  expect(ts.getPreEmitDiagnostics(program)).toEqual([]);
  const rows = measureSource({ source, file: 'virtual.ts' }); expect(rows[0].cyclomatic).toBe(15); console.log('14-arm switch measured cyclomatic:', rows[0].cyclomatic);
 });
 it.each(['for (;;)','for (const item of [])','for (const item in {})','while (true)','do','switch (1)','try','if (true)'])('covers nested control %s', async control => {
  const inner = control === 'do' ? 'do {} while(true);' : control === 'try' ? 'try {} catch {}' : control === 'switch (1)' ? 'switch(1) { case 1: break; }' : control + ' {}';
  const source = 'function check(required: {}) { if(true) { if(true) { if(true) { '+inner+' } } } }';
  const result = await eslint.lintText(source, { filePath: 'development/fixtures/virtual.ts' });
  expect(result[0].messages.some(message => message.ruleId === 'om/control-depth')).toBe(true);
 });
});
it('metric collection covers methods, class initializers and nested functions without header ambiguity', () => {
 const rows = measureSource({ source: 'class Example { value = true ? 1 : 0; method(required: {}) { return (() => 1)(); } }', file: 'virtual.ts' });
 expect(rows.map(row => row.cyclomatic)).toEqual([2,1,1]);
 expect(rows.every(row => Number.isFinite(row.nloc) && Number.isFinite(row.nesting))).toBe(true);
});
it('contextual object methods pass and owned lookalike callbacks cannot borrow a foreign ABI', async () => {
 const source = 'interface Port { run(input: { id: string }): void } export const port: Port = { run(input) {} }; const owned = { map(callback: (value: number) => number) { return callback(1); } }; owned.map(value => value);';
 const results = await eslint.lintText(source, { filePath: 'development/fixtures/virtual.ts' });
 expect(results[0].messages.filter(message => message.ruleId === 'om/two-object-arguments')).toHaveLength(3);
});
it('utility aliases, callable interfaces, unboxed destructuring and scalar function types fail', async () => {
 for (const source of ['function wrong(input: Readonly<string>) {}', 'type Wrong = (input: string) => void;', 'interface Callback { (): void } function wrong(input: Callback) {}', 'function wrong({ length }: string) {}']) {
  const results = await eslint.lintText(source, { filePath: 'development/fixtures/virtual.ts' });
  expect(results[0].messages.some(message => message.ruleId === 'om/two-object-arguments')).toBe(true);
 }
});
it('imported scalar aliases fail while imported object contracts pass', async () => {
 const results = await eslint.lintText('import type { OperationId, CallContext } from "@open-marketing/contracts"; function bad(input: OperationId) {} function good(input: CallContext) {}', { filePath: 'development/fixtures/virtual.ts' });
 expect(results[0].messages.filter(message => message.ruleId === 'om/two-object-arguments')).toHaveLength(1);
});
it('the foreign exception only covers a callable argument and JSX cannot bypass component rules', async () => {
 const results = await eslint.lintText('export function check(required: { values: number[] }) { return required.values.map(value => value, (scalar: number) => scalar); }', { filePath: 'development/fixtures/virtual.ts' });
 expect(results[0].messages.filter(message => message.ruleId === 'om/two-object-arguments')).toHaveLength(1);
 expect((await fixture({ name: 'jsx-arrow', extension: 'jsx' })).messages.some(message => message.ruleId === 'om/no-functions-in-component-body')).toBe(true);
});
it('chained foreign callbacks resolve the whole call span', async () => {
 const results = await eslint.lintText('function check(required: { values: number[] }) { return required.values.filter(value => value > 0).map(value => value + 1).join(","); }', { filePath: 'development/fixtures/virtual.ts' });
 expect(results[0].messages).toEqual([]);
});

it.each([
 'import { createServer } from "node:http"; createServer((request, response) => { response.end(); });',
 'import type { Session } from "electron"; function register(required: { session: Session }) { required.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false)); }',
 'import type { SqliteClient } from "@jini-ai/db/sqlite"; function adapter(required: { native: SqliteClient }): SqliteClient { return { ...required.native, prepare: source => required.native.prepare(source) }; }',
 'new Promise<void>((resolve, reject) => { resolve(); });',
 'import type { SqliteClient } from "@jini-ai/db/sqlite"; function adapter(required: { native: SqliteClient }): SqliteClient { return { ...required.native, exec(source) { required.native.exec(source); } }; }',
 'import { useState } from "react"; function state() { const [value, setValue] = useState(0); setValue(current => current + 1); }',
 'const transport: typeof fetch = async (input, init) => fetch(input, init);',
 'import { vi } from "vitest"; import type { Database } from "better-sqlite3"; function adapter(required: { database: Database }) { vi.spyOn(required.database, "exec").mockImplementation(source => required.database); }',
])('recognizes a genuine upstream callback ABI: %s', async source => {
 const results = await eslint.lintText(source, { filePath: source.includes('electron') ? 'apps/desktop/virtual.ts' : source.includes('react') ? 'apps/studio/virtual.ts' : 'apps/server/virtual.ts' });
 expect(results[0].messages).toEqual([]);
});
it.each([
 'const owned = { createServer(callback: (request: string, response: string) => void) {} }; owned.createServer((request, response) => {});',
 'interface Session { setPermissionRequestHandler(callback: (contents: string, permission: string, callback: () => void) => void): void } function register(required: { session: Session }) { required.session.setPermissionRequestHandler((contents, permission, callback) => {}); }',
 'interface Client { prepare(source: string): void } function adapter(required: { native: Client }): Client { return { prepare: source => required.native.prepare(source) }; }',
 'class Deferred { constructor(callback: (resolve: () => void, reject: (reason: string) => void) => void) {} } new Deferred((resolve, reject) => resolve());',
 'interface Client { exec(source: string): void } function adapter(required: { native: Client }): Client { return { exec(source) { required.native.exec(source); } }; }',
 'function state() { const setValue = (callback: (current: number) => number) => callback(0); setValue(current => current + 1); }',
 'type Fetch = (input: string, init?: {}) => Promise<void>; const transport: Fetch = async (input, init) => {};',
 'import { vi } from "vitest"; function adapter(required: { owned: { exec(input: string): void } }) { vi.spyOn(required.owned, "exec").mockImplementation(input => {}); }',
])('rejects an owned lookalike of an upstream ABI: %s', async source => {
 const results = await eslint.lintText(source, { filePath: source.includes('electron') ? 'apps/desktop/virtual.ts' : source.includes('react') ? 'apps/studio/virtual.ts' : 'apps/server/virtual.ts' });
 const implementationType = source.includes('exec(source) {') ? 'FunctionExpression' : 'ArrowFunctionExpression';
 const expected = source.includes('function state()') ? 2 : 1;
 expect(results[0].messages.filter(message => message.ruleId === 'om/two-object-arguments' && message.nodeType === implementationType)).toHaveLength(expected);
});
