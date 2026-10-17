import { spawnSync } from 'node:child_process';
import { accessSync, constants, cpSync, existsSync, globSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';

const manifest = ({ directory }) => JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));

/** Assert build inputs before deleting staging; filesystem errors abort packaging. */
function requirePath({ path }) {
 if (!existsSync(path)) throw new Error(`Missing packaging input: ${path}. Supply a coherent build snapshot first.`);
}

/** Node's upward lookup, adapted from Tovu apps/desktop/src/stage-payload-lib.ts.
 * stopAt prevents a staged lookup from borrowing dependencies from the checkout.
 */
function findPackageDir({ from, name, stopAt }) {
 for (let directory = from; ; directory = dirname(directory)) {
  const candidate = join(directory, 'node_modules', name);
  if (existsSync(join(candidate, 'package.json'))) return realpathSync(candidate);
  if (directory === stopAt || dirname(directory) === directory) return undefined;
 }
}

/** Preserve installed production and peer resolutions, including pnpm's Zod 3 peers.
 * Missing optional packages are skipped; missing required edges throw before builder runs.
 */
function dependencyEdges({ source }) {
 const pkg = manifest({ directory: source });
 const names = new Set([...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.peerDependencies ?? {}), ...Object.keys(pkg.optionalDependencies ?? {})]);
 const edges = [];
 for (const name of names) {
  const resolved = findPackageDir({ from: source, name });
  const optional = name in (pkg.optionalDependencies ?? {}) || pkg.peerDependenciesMeta?.[name]?.optional;
  if (resolved) edges.push({ name, source: resolved });
  else if (!optional) throw new Error(`Unresolved production dependency: ${pkg.name} -> ${name} (${source})`);
 }
 return edges;
}

/** Dereference installed packages; owned workspaces ship only their manifest and build.
 * Third-party notices are retained. No source node_modules tree is copied implicitly.
 */
function copyPackage({ source, target }) {
 const pkg = manifest({ directory: source });
 mkdirSync(target, { recursive: true });
 if (!pkg.om) {
  // node:fs filter is a foreign (source, destination) callback ABI.
  cpSync(source, target, { recursive: true, dereference: true, filter: path => basename(path) !== 'node_modules' });
  return;
 }
 requirePath({ path: join(source, 'dist') });
 cpSync(join(source, 'package.json'), join(target, 'package.json'));
 cpSync(join(source, 'dist'), join(target, 'dist'), { recursive: true, dereference: true });
}

/** Stage a production closure, hoisting the first installed instance and nesting conflicts.
 * Adapted from Tovu's declaredDependencies/findPackageDir/stageTransitiveDependencies.
 * @example stageTransitiveDependencies({ source: serverDir, outDir: stagedServerDir });
 * @returns void; throws on unresolved dependencies or copy failures. Mutates only outDir.
 * @complexity O(E * H + B) time for dependency edges E, lookup depth H and copied bytes B;
 * O(P) bookkeeping for staged package instances P. Ancestor reuse terminates cycles.
 */
export function stageTransitiveDependencies({ source, outDir }) {
 source = realpathSync(source);
 mkdirSync(outDir, { recursive: true });
 outDir = realpathSync(outDir);
 const sources = new Map([[outDir, source]]);
 const queue = [{ source, target: outDir }];
 for (let cursor = 0; cursor < queue.length; cursor += 1) {
  const dependent = queue[cursor];
  for (const edge of dependencyEdges({ source: dependent.source })) {
   const visible = findPackageDir({ from: dependent.target, name: edge.name, stopAt: outDir });
   if (sources.get(visible) === edge.source) continue;
   let target = join(outDir, 'node_modules', edge.name);
   if (sources.has(target)) target = join(dependent.target, 'node_modules', edge.name);
   copyPackage({ source: edge.source, target });
   sources.set(target, edge.source);
   queue.push({ source: edge.source, target });
  }
 }
}

/** Validate the supplied official Node directory; never substitute a system Node. */
function validateNode({ nodeDirectory }) {
 if (process.platform !== 'darwin' || process.arch !== 'x64') throw new Error('This unsigned packaging configuration requires a darwin x64 host; arm64 signing is deferred.');
 requirePath({ path: join(nodeDirectory, 'LICENSE') });
 const executable = join(nodeDirectory, 'bin/node');
 accessSync(executable, constants.X_OK);
 const checked = spawnSync(executable, ['-p', "process.version+' '+process.arch"], { encoding: 'utf8', timeout: 10000 });
 if (checked.status !== 0 || checked.stdout.trim() !== 'v24.2.0 x64') throw new Error('Provide the checksum-verified official node-v24.2.0-darwin-x64 directory via --node-dir.');
}

/** Collect runtime inputs without loading server code or starting services. */
function runtimeInputs({ repoRoot }) {
 const required = ['apps/desktop/dist/main.js', 'apps/server/dist/composition/serve.js', 'apps/agent/dist/composition/serve.js', 'apps/studio/dist/index.html'];
 const plugins = globSync('content/agent-plugins/*/plugin.json', { cwd: repoRoot }).map(path => dirname(path));
 for (const plugin of plugins) {
  if (existsSync(join(repoRoot, plugin, 'package.json'))) required.push(`${plugin}/io.github.ainsep.openmarketing/dist/index.mjs`);
 }
 const chart = 'content/plugins/charts-recharts/0.1.0';
 const chartManifest = JSON.parse(readFileSync(join(repoRoot, chart, 'jini.plugin.json'), 'utf8'));
 required.push(...Object.keys(chartManifest.integrity).map(path => `${chart}/${path}`));
 for (const path of required) requirePath({ path: join(repoRoot, path) });
 return { plugins, chart };
}

/** Write the isolated Electron shell so builder never traverses desktop's pnpm links. */
function stageShell({ desktop, staging }) {
 const target = join(staging, 'app');
 mkdirSync(target, { recursive: true });
 const { version } = manifest({ directory: desktop });
 writeFileSync(join(target, 'package.json'), JSON.stringify({ name: 'open-marketing-desktop', productName: 'Open Marketing', version, main: 'dist/main.js', type: 'module', dependencies: { zod: '4.1.13' } }, null, 2));
 for (const path of globSync('dist/**/*.js', { cwd: desktop })) {
  mkdirSync(dirname(join(target, path)), { recursive: true });
  cpSync(join(desktop, path), join(target, path));
 }
 copyPackage({ source: realpathSync(join(desktop, 'node_modules/zod')), target: join(target, 'node_modules/zod') });
}

/** Stage existing outputs only; no builds, installs, migrations or vendor calls. */
function stageRuntime({ repoRoot, staging, nodeDirectory, inputs }) {
 rmSync(staging, { recursive: true, force: true });
 stageShell({ desktop: join(repoRoot, 'apps/desktop'), staging });
 const om = join(staging, 'om');
 for (const app of ['server', 'agent']) {
  const source = join(repoRoot, 'apps', app);
  const outDir = join(om, 'apps', app);
  copyPackage({ source, target: outDir });
  stageTransitiveDependencies({ source, outDir });
 }
 cpSync(join(repoRoot, 'apps/studio/dist'), join(om, 'apps/studio/dist'), { recursive: true, dereference: true });
 for (const path of globSync(['features/*/migrations/*.sql', 'apps/server/migrations/*.sql'], { cwd: repoRoot })) {
  mkdirSync(dirname(join(om, path)), { recursive: true });
  cpSync(join(repoRoot, path), join(om, path));
 }
 for (const path of [...inputs.plugins, inputs.chart]) {
  cpSync(join(repoRoot, path), join(om, path), { recursive: true, dereference: true, filter: source => !['src', 'tests', 'node_modules'].includes(basename(source)) });
 }
 mkdirSync(join(staging, 'node/bin'), { recursive: true });
 cpSync(join(nodeDirectory, 'bin/node'), join(staging, 'node/bin/node'));
 cpSync(join(nodeDirectory, 'LICENSE'), join(staging, 'node/LICENSE'));
}

/** Return builder API options for an absolute desktop directory; no I/O.
 * npmRebuild must stay enabled so beforeBuild runs: app-builder-lib 26.15.3
 * out/packager.js:454-469 marks node_modules externally handled, and
 * out/platformPackager.js:366-368 then skips automatic dependency collection.
 * @example desktopBuildOptions({ desktop: '/checkout/apps/desktop' });
 * @complexity O(1) time and space; fixed file mappings only.
 */
export function desktopBuildOptions({ desktop }) {
 return {
  projectDir: desktop, mac: [], publish: 'never',
  config: {
   appId: 'io.github.ainsep.openmarketing.desktop', productName: 'Open Marketing',
   directories: { app: 'staging/app', output: 'release' },
   electronVersion: '39.2.3', electronDist: join(desktop, 'node_modules/electron/dist'),
   npmRebuild: true,
   // Builder's context callback is intentionally ignored: staging owns every dependency.
   beforeBuild: () => false,
   asar: true,
   files: ['dist/**/*.js', 'package.json', { from: 'node_modules/zod', to: 'node_modules/zod', filter: ['**/*'] }],
   mac: {
    target: ['dmg', 'dir'], identity: null, hardenedRuntime: false, notarize: false,
    electronLanguages: ['en'], artifactName: 'Open-Marketing-${arch}.${ext}',
   },
   dmg: { sign: false },
   extraResources: [
    { from: 'staging/om', to: 'om', filter: ['**/*', '!**/node_modules/**'] },
    // Builder skips node_modules inside a parent resource; copy each root explicitly.
    { from: 'staging/om/apps/server/node_modules', to: 'om/apps/server/node_modules', filter: ['**/*'] },
    { from: 'staging/om/apps/agent/node_modules', to: 'om/apps/agent/node_modules', filter: ['**/*'] },
    { from: 'staging/node', to: 'node' },
    { from: 'node_modules/electron/dist/LICENSE', to: 'licenses/LICENSE.electron.txt' },
    { from: 'node_modules/electron/dist/LICENSES.chromium.html', to: 'licenses/LICENSES.chromium.html' },
   ],
  },
 };
}

/** CLI boundary: validate and stage before awaiting builder; failures reject to the CLI.
 * Writes staging/release and logs artifact paths. Explicit Node input is required.
 */
async function main({ args }) {
 if (args[0] === '--') args = args.slice(1);
 const { values } = parseArgs({ args, options: { 'node-dir': { type: 'string' } }, strict: true });
 if (!values['node-dir']) throw new Error('Usage: corepack pnpm om:package -- --node-dir <checksum-verified-node-v24.2.0-darwin-x64-directory>');
 const nodeDirectory = resolve(values['node-dir']);
 validateNode({ nodeDirectory });
 const repoRoot = resolve(import.meta.dirname, '../..');
 const desktop = join(repoRoot, 'apps/desktop');
 const inputs = runtimeInputs({ repoRoot });
 const staging = join(desktop, 'staging');
 stageRuntime({ repoRoot, staging, nodeDirectory, inputs });
 const { build } = createRequire(join(desktop, 'package.json'))('electron-builder');
 await build(desktopBuildOptions({ desktop }));
 console.log(join(desktop, 'release/mac/Open Marketing.app'));
 console.log(join(desktop, 'release/Open-Marketing-x64.dmg'));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
 try { await main({ args: process.argv.slice(2) }); }
 catch (error) { console.error(`Packaging failed: ${error.message}`); process.exitCode = 1; }
}
