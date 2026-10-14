import { readFileSync, existsSync, realpathSync } from 'node:fs';
import { resolve, dirname, relative, isAbsolute } from 'node:path';
import ts from 'typescript';
import { cruise } from 'dependency-cruiser';
import { workspacePackages, sourceFiles } from './workspace.mjs';
import { fileURLToPath } from 'node:url';
/** Read every original import spelling, including type queries, require and dynamic imports. */
export function importSpecifiers({ source, file }) {
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const result = [];
  function visit({ node }) {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) add({ node: node.moduleSpecifier, kind: 'static', names: bindingNames({ node }) });
    if (ts.isImportTypeNode(node)) add({ node: node.argument.literal, kind: 'type', names: [node.qualifier?.getText(ast) ?? '*'] });
    if (ts.isImportEqualsDeclaration(node)) add({ node: node.moduleReference.expression, kind: 'require' });
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || node.expression.text === 'require')) add({ node: node.arguments[0], kind: 'dynamic' });
    ts.forEachChild(node, child => visit({ node: child }));
  }
  function add({ node, kind, names = ['*'] }) { if (node) result.push({ specifier: ts.isStringLiteralLike(node) ? node.text : null, kind, names }); }
  visit({ node: ast });
  return result;
}
function bindingNames({ node }) {
 const bindings = node.importClause?.namedBindings ?? node.exportClause;
 if (!bindings?.elements || node.importClause?.name) return ['*'];
 return Array.from(bindings.elements).map(element => (element.propertyName ?? element.name).text);
}
const purePolicyExports = new Set(['sendability','shareability','spendability','TimeWindow','Consent','Suppression','FrequencyCap','SubjectPolicy','ShareDestination','MessageChannel','Money','BudgetAuthorization','AdAccountPolicy','DenialReason','GateDecision']);
/** Package ownership is discovered, never inferred from a second feature folder list. */
function ownerOf({ file, packages }) { return Array.from(packages).find(pkg => file === pkg.path || file.startsWith(pkg.path + '/')); }
/** Resolve TS and workspace public entries, preserving original spelling separately. */
function resolveImport({ source, file, packages, root }) {
  const pkg = Array.from(packages).find(item => source === item.name);
  if (pkg) return resolve(root, pkg.path, pkg.exports['.'].types);
  const options = compilerOptions({ file, packages, root });
  const compiled = ts.resolveModuleName(source, resolve(root, file), options, ts.sys).resolvedModule;
  if (compiled) return realpathSync(compiled.resolvedFileName);
  const deep = Array.from(packages).find(item => source.startsWith(item.name + '/'));
  if (deep) return resolve(root, deep.path, deep.exports['.'].types);
  if (source.startsWith('.') || isAbsolute(source)) return resolve(root, dirname(file), source.replace(/\.js$/, '.ts'));
  return null;
}
function compilerOptions({ file, packages, root }) {
 const owner = ownerOf({ file, packages }); const configPath = resolve(root, owner?.path ?? '.', 'tsconfig.json');
 if (!existsSync(configPath)) return { moduleResolution: ts.ModuleResolutionKind.NodeNext, module: ts.ModuleKind.NodeNext, allowJs: true };
 const config = ts.readConfigFile(configPath, ts.sys.readFile);
 return ts.parseJsonConfigFileContent(config.config, ts.sys, dirname(configPath)).options;
}
/** Downward FSD layer edges and public entries; same-slice imports remain local. */
function fsdViolation({ from, to }) {
  const layers = ['shared', 'entities', 'features', 'widgets', 'pages', 'app'];
  const left = from.split('/src/')[1]?.split('/');
  const right = to.split('/src/')[1]?.split('/');
  if (!left || !right || !layers.includes(left[0]) || !layers.includes(right[0])) return false;
  if (left[0] === right[0] && left[1] === right[1]) return false;
  if (layers.indexOf(right[0]) >= layers.indexOf(left[0])) return true;
  return !['app', 'shared'].includes(right[0]) && !/\/index\.[cm]?[tj]s$/.test(to);
}
/** Typed and runtime import edges have identical rules. @complexity Constant work per edge. */
const edgeRules = [
 ['feature-public-name', ({ source, target, specifier, kind }) => target?.om?.kind === 'feature' && source?.name !== target.name && (specifier !== target.name || kind === 'dynamic')],
 ['feature-to-feature', ({ source, target }) => source?.om?.kind === 'feature' && target?.om?.kind === 'feature' && source.name !== target.name && !(source.name.match(/\/(safety|measure)$/) && target.name === '@open-marketing/policy')],
 ['policy-pure-gates-only', ({ source, target, names }) => /\/(safety|measure)$/.test(source?.name ?? '') && target?.name === '@open-marketing/policy' && Array.from(names).some(name => !purePolicyExports.has(name))],
 ['core-to-adapter', ({ source, from, to }) => source?.om?.kind === 'feature' && /\/src\//.test(from) && !/\/adapters\//.test(from) && /\/adapters\//.test(to)],
 ['feature-to-app', ({ source, target }) => source?.om?.kind === 'feature' && target?.om?.kind === 'app'],
 ['client-to-backend', ({ from, to, target }) => /^apps\/(studio|desktop|agent)\//.test(from) && (target?.om?.kind === 'feature' || /^apps\/server\/|^content\/agent-plugins\//.test(to))],
 ['server-to-agent', ({ from, to }) => /^apps\/server\//.test(from) && /^apps\/agent\//.test(to)],
 ['cli-shortcut', ({ from, to, target }) => /\/cli\//.test(from) && (target?.om?.kind === 'feature' || /\/composition\//.test(to))],
 ['impure-contracts', ({ source, target, to, specifier }) => source?.name === '@open-marketing/contracts' && (target?.om?.kind === 'app' || target?.om?.kind === 'feature' || /^(content|development)\//.test(to) || /^(node:|react|electron|pg)/.test(specifier))],
 ['production-to-nonproduction', ({ from, to }) => !/\/(tests|fixtures|experiments|parked)\//.test(from) && /\/(tests|fixtures|experiments|parked)\//.test(to)],
 ['fsd-edge', ({ from, to }) => /^apps\/studio\//.test(from) && /^apps\/studio\//.test(to) && fsdViolation({ from, to })],
 ['sibling-source', ({ to }) => to.startsWith('../') || /(^|\/)(Tovu|Jini)(\/|$)/.test(to)],
 ['core-to-driver', ({ from, source, specifier }) => source?.om?.kind === 'feature' && !/\/(adapters|tests)\//.test(from) && /^(node:(fs|child_process|http|https|net|tls|process)|pg$|@electric-sql|@modelcontextprotocol\/sdk|react$|electron$)/.test(specifier)],
 ['vendor-outside-plugin', ({ from, specifier }) => !from.startsWith('content/agent-plugins/') && /^(google-ads-api|@googleads|facebook-nodejs-business-sdk|@higgsfield)/.test(specifier)],
 ['server-agent-runtime', ({ from, specifier }) => from.startsWith('apps/server/') && /^@jini-ai\/(agent-runtime|daemon)/.test(specifier)],
];
/** Typed and runtime import edges have identical rules. Each decision remains independently fixture-testable. */
export function edgeViolations({ from, to, specifier, kind = 'static', names = ['spendability'], packages }) {
 const input = { from, to, specifier, kind, names, source: ownerOf({ file: from, packages }), target: ownerOf({ file: to, packages }) };
 return edgeRules.filter(([name, check]) => check(input)).map(([name]) => name);
}
/** Full graph cycles include unchanged files and type-only edges. */
export function graphCycles({ edges }) {
  const nodes = new Map();
  for (const edge of edges) { if (!nodes.has(edge.from)) nodes.set(edge.from, []); nodes.get(edge.from).push(edge.to); }
  const done = new Set(); const active = new Set(); const failures = [];
  function visit({ node }) {
    if (active.has(node)) { failures.push(`cycle: ${node}`); return; }
    if (done.has(node)) return;
    active.add(node);
    for (const child of nodes.get(node) ?? []) visit({ node: child });
    active.delete(node); done.add(node);
  }
  for (const node of nodes.keys()) visit({ node });
  return failures;
}
/** Validate dependency declarations and feature public entries from portable workspace metadata. */
function manifestViolations({ packages, root }) {
  const failures = [];
  for (const pkg of packages) failures.push(...packageManifestViolations({ pkg, packages, root }));
  const rootManifest = existsSync(resolve(root, 'package.json')) ? JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) : {};
  for (const [name, version] of Object.entries({ ...rootManifest.dependencies, ...rootManifest.devDependencies })) failures.push(...dependencyDeclarationViolations({ pkg: rootManifest, name, version, packages }));
  return failures;
}
/** Manifest identity, exports, declarations, and explicit composition ownership. */
function packageManifestViolations({ pkg, packages, root }) {
 const failures = [];
 if (pkg.om?.kind === 'feature' && (Object.keys(pkg.exports ?? {}).join() !== '.' || pkg.exports['.'].types !== './index.ts')) failures.push(`${pkg.name}: public-entry`);
 if (pkg.absolute !== root && !pkg.absolute.startsWith(root + '/')) failures.push(`${pkg.name}: outside-root-symlink`);
 for (const [name, version] of Object.entries({ ...pkg.dependencies, ...pkg.devDependencies })) failures.push(...dependencyDeclarationViolations({ pkg, name, version, packages }));
 if (pkg.om?.kind === 'app') {
  const roots = sourceFiles({ root }).filter(file => file.startsWith(pkg.path + '/') && /\/composition\/index\.[cm]?[tj]sx?$/.test(file));
  if (roots.length !== 1 || roots[0] !== `${pkg.path}/${pkg.om.composition}`) failures.push(`${pkg.name}: composition-root-count`);
 }
 return failures;
}
function dependencyDeclarationViolations({ pkg, name, version, packages }) {
 if (/^(file:|link:)/.test(version)) return [`${pkg.name}: sibling/local dependency ${name}`];
 if (version.startsWith('workspace:') && !Array.from(packages).some(item => item.name === name)) return [`${pkg.name}: missing workspace ${name}`];
 return [];
}
/** Uploaded plugins are unrestricted (owner, 2026-10-13), so their code must be loaded by computed URL.
 * Only the two executable boundaries may do that and inject the loader: the server's serve.ts (plugin code)
 * and studio's main.ts (enabled chart-provider bundles in the browser).
 */
const pluginLoaderFiles = new Set(['apps/server/src/composition/serve.ts', 'apps/studio/src/main.ts']);
export function nonliteralImportAllowed({ file }) {
 return pluginLoaderFiles.has(file);
}
function nonliteralFailures({ file }) {
 return nonliteralImportAllowed({ file }) ? [] : [`${file}: nonliteral-module-import`];
}
/** Original specifiers are resolved independently of the graph analyzer. */
function fileEdges({ file, root, packages }) {
 const failures = []; const edges = [];
 for (const entry of importSpecifiers({ source: readFileSync(resolve(root, file), 'utf8'), file })) {
  if (!entry.specifier) { failures.push(...nonliteralFailures({ file })); continue; }
  const absolute = resolveImport({ source: entry.specifier, file, packages, root });
  const target = absolute ? relative(root, absolute).replaceAll('\\', '/') : entry.specifier;
  failures.push(...edgeViolations({ from: file, to: target, specifier: entry.specifier, kind: entry.kind, names: entry.names, packages }).map(reason => `${file} -> ${entry.specifier}: ${reason}`));
  if (absolute && !absolute.includes('/node_modules/')) edges.push({ from: file, to: target });
 }
 return { failures, edges };
}
/** Combine real dependency-cruiser graph analysis with original specifiers and TS resolution. */
export async function checkBoundaries({ root = process.cwd() } = {}) {
  root = realpathSync(root);
  const packages = workspacePackages({ root }); const files = sourceFiles({ root });
  const failures = manifestViolations({ packages, root }); const edges = [];
  for (const file of files) { const result = fileEdges({ file, root, packages }); failures.push(...result.failures); edges.push(...result.edges); }
  failures.push(...graphCycles({ edges }));
  const graph = await cruise(files.map(file => relative(process.cwd(), resolve(root, file))), { validate: true, tsPreCompilationDeps: true, doNotFollow: { path: 'node_modules|/dist/' }, ruleSet: { forbidden: [{ name: 'no-cycles', severity: 'error', from: {}, to: { circular: true } }] } });
  const output = typeof graph.output === 'string' ? JSON.parse(graph.output) : graph.output;
  failures.push(...Array.from(output.summary?.violations ?? []).map(violation => `${violation.from}: dependency-cruiser ${violation.rule.name}`));
  return { failures, edges, analyzer: 'dependency-cruiser@17.3.2' };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = await checkBoundaries(); console.log(result.failures.join('\n') || 'OM graph/specifier boundaries PASS'); process.exitCode = result.failures.length ? 1 : 0;
}
