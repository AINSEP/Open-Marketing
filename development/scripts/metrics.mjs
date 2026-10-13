import { Linter } from 'eslint';
import { builtinRules } from 'eslint/use-at-your-own-risk';
import parser from '@typescript-eslint/parser';
import sonarjs from 'eslint-plugin-sonarjs';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { sourceFiles } from './workspace.mjs';
import { nestingDepth } from '../eslint-rules/index.mjs';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
const require = createRequire(import.meta.url);
/** Wrap the pinned analyzer's reporter, retaining its measured value and exact node identity. */
function metricRule({ rule, measurements }) {
 return { ...rule, create({ sourceCode, options, settings, languageOptions, filename }) {
  const context = { sourceCode, options, settings, languageOptions, filename,
   report({ ...measurement }) { measurements.push(measurement); }, getSourceCode: () => sourceCode,
  };
  return rule.create(context);
 } };
}
/** Run the real ESLint complexity rule at report threshold zero; threshold is used solely for collecting metrics.
 * Both AST passes use the source filename's syntax, including generic TypeScript arrows.
 * @complexity O(b + f*t) time, O(b+f) space: b source bytes, f functions, t tokens.
 * Syntax failures throw rather than omit a source.
 */
export function measureSource({ source, file }) {
 const measurements = []; const linter = new Linter();
 const parserOptions = { filePath: file, ecmaFeatures: { jsx: /\.[jt]sx$/.test(file) } };
 const parsed = parser.parseForESLint(source, { ...parserOptions, tokens: true, loc: true, range: true });
 const collector = { rules: { cyclomatic: metricRule({ rule: builtinRules.get('complexity'), measurements }) } };
 const diagnostics = linter.verify(source, [{ files: ['**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}'], languageOptions: { parser, parserOptions }, plugins: { collector, sonarjs }, rules: { 'collector/cyclomatic': ['error', { max: 0, variant: 'classic' }], 'sonarjs/cognitive-complexity': ['error', 0] } }], { filename: file });
 if (diagnostics.some(item => item.fatal)) throw new Error(`Metric parse failure: ${file}`);
 return measurements.map(measurement => metricRow({ measurement, diagnostics, parsed, file }));
}
/** NLOC uses executable parser tokens; nesting is measured with the same control definition as the gate. */
function metricRow({ measurement, diagnostics, parsed, file }) {
 const node = measurement.node;
 const head = measurement.loc.start;
 const cognitive = Array.from(diagnostics).find(item => item.ruleId === 'sonarjs/cognitive-complexity' && withinHeader({ item, head, body: node.body?.loc.start ?? node.loc.end }));
 const tokens = parsed.ast.tokens;
 const nloc = new Set(Array.from(tokens).filter(token => token.range[0] >= node.range[0] && token.range[1] <= node.range[1]).flatMap(token => Array.from({ length: token.loc.end.line - token.loc.start.line + 1 }, (_, index) => token.loc.start.line + index))).size;
 const nesting = functionDepth({ node, keys: parsed.visitorKeys });
 return { file, line: node.loc.start.line, column: node.loc.start.column, cyclomatic: measurement.data.complexity, cognitive: cognitive ? Number(cognitive.message.match(/from (\d+)/)[1]) : 0, nesting, nloc };
}
function withinHeader({ item, head, body }) {
 const afterStart = item.line > head.line || (item.line === head.line && item.column >= head.column + 1);
 const beforeBody = item.line < body.line || (item.line === body.line && item.column <= body.column + 1);
 return afterStart && beforeBody;
}
/** Nested functions have independent control depth. No size or cyclomatic magnitude is gated. */
function functionDepth({ node, keys }) {
 let depth = 0;
 function visit({ child }) {
  if (child !== node && /^(FunctionDeclaration|FunctionExpression|ArrowFunctionExpression)$/.test(child.type)) return;
  if (/^(IfStatement|ForStatement|ForInStatement|ForOfStatement|WhileStatement|DoWhileStatement|SwitchStatement|TryStatement|CatchClause|ConditionalExpression)$/.test(child.type)) depth = Math.max(depth, nestingDepth({ node: child }));
  for (const descendant of astChildren({ node: child, keys })) visit({ child: descendant });
 }
 visit({ child: node }); return depth;
}
function astChildren({ node, keys }) { return Array.from(keys[node.type] ?? []).flatMap(key => Array.isArray(node[key]) ? node[key] : [node[key]]).filter(child => child?.type); }
/** Every owned source is analyzed afresh. Generated output never becomes source authority. */
export function metricReport({ root = process.cwd() } = {}) {
 const files = sourceFiles({ root }).sort(); const rows = files.flatMap(file => measureSource({ source: readFileSync(`${root}/${file}`, 'utf8'), file }));
 const versions = { eslint: require('eslint/package.json').version, 'eslint-plugin-sonarjs': require('eslint-plugin-sonarjs/package.json').version, '@typescript-eslint/parser': require('@typescript-eslint/parser/package.json').version };
 const pinned = JSON.parse(readFileSync(`${root}/package.json`, 'utf8')).devDependencies;
 if (Object.entries(versions).some(([name, version]) => pinned[name] !== version)) throw new Error('Metric analyzer version differs from pinned workspace dependency');
 const digests = Object.fromEntries(files.map(file => [file, createHash('sha256').update(readFileSync(`${root}/${file}`)).digest('hex')]));
 const report = { analyzers: versions, sourceDigests: digests, scope: files, functions: rows };
 if (rows.some(row => !Number.isFinite(row.cyclomatic) || !Number.isFinite(row.nloc) || !Number.isFinite(row.nesting))) throw new Error('Metric integrity missing measurement');
 mkdirSync(`${root}/.tmp`, { recursive: true }); writeFileSync(`${root}/.tmp/om-metrics.json`, JSON.stringify(report, null, 2) + '\n'); return report;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) { const report = metricReport(); console.log(`OM metric integrity PASS: ${report.scope.length} sources, ${report.functions.length} functions; cyclomatic/NLOC report only (.tmp/om-metrics.json)`); }
