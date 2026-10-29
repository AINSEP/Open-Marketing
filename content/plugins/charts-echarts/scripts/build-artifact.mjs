/** Build-only adaptation of Jini charts-recharts/scripts/build-artifact.mjs (Apache-2.0).
 * Produces the same five-file OM artifact; run only after Coordinator dependency provisioning.
 */
import { build } from 'esbuild';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const artifact = join(root, '0.1.0');
const metadata = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
if (!metadata.private) throw new Error('Chart build packages must remain private.');
await mkdir(join(artifact, 'client'), { recursive: true });
const result = await build({
  absWorkingDir: root, entryPoints: ['src/provider.ts'], outfile: '0.1.0/client/provider.js',
  bundle: true, format: 'esm', platform: 'browser', target: 'es2022', minify: true,
  legalComments: 'inline', metafile: true, define: { 'process.env.NODE_ENV': '"production"' },
});
if (Object.values(result.metafile.outputs).some(output => output.imports.length > 0)) throw new Error('Browser bundle has external imports.');

/** Locate each actual bundled package, including transitive packages, for license attribution. */
async function packageFor({ directory }) {
  try {
    const info = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
    if (info.name && info.version) return { directory, info };
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const parent = dirname(directory);
  if (parent === directory) throw new Error('Bundled dependency has no package metadata.');
  return packageFor({ directory: parent });
}

const packages = new Map();
for (const file of Object.keys(result.metafile.inputs).sort()) {
  if (!file.includes('node_modules/')) continue;
  const entry = await packageFor({ directory: dirname(resolve(root, file)) });
  packages.set(entry.directory, entry.info);
}
const licenses = [];
for (const [directory, info] of packages) {
  const expected = metadata.dependencies[info.name] ?? metadata.devDependencies[info.name];
  if (expected && expected !== info.version) throw new Error('Bundled dependency differs from exact package pin: ' + info.name);
  const files = (await readdir(directory, { withFileTypes: true }))
    .filter(entry => entry.isFile() && /^(licen[sc]e|notice|copyright)/i.test(entry.name));
  if (files.length === 0) throw new Error('Bundled package has no license text: ' + info.name);
  licenses.push(info.name + ' ' + info.version + ' (' + info.license + ')');
  for (const file of files.sort((a, b) => a.name.localeCompare(b.name))) {
    licenses.push(file.name + '\n' + await readFile(join(directory, file.name), 'utf8'));
  }
}
const separator = 'Bundled dependency licenses:\n';
const previous = await readFile(join(artifact, 'NOTICE'), 'utf8');
const provenance = previous.split(separator)[0].replace(/SOURCE ONLY:[\s\S]*/, 'Standalone bundle; all runtime dependencies are included.\n');
await writeFile(join(artifact, 'NOTICE'), provenance.trimEnd() + '\n\n' + separator + licenses.join('\n\n') + '\n');
const paths = ['client/provider.js', 'client/styles.css', 'server/index.mjs', 'NOTICE'];
const integrity = {};
for (const path of paths) {
  integrity[path] = 'sha256-' + createHash('sha256').update(await readFile(join(artifact, path))).digest('hex');
}
const manifestPath = join(artifact, 'jini.plugin.json');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
if (manifest.version !== metadata.version) throw new Error('Artifact/package version mismatch.');
await writeFile(manifestPath, JSON.stringify({ ...manifest, integrity }, null, 2) + '\n');
