import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve, relative } from 'node:path';
import { workspacePackages, sourceFiles } from './workspace.mjs';
import { sourceDigest } from './source-digest.mjs';
/** Package-scoped compiler wrapper; receipts attest exactly the freshly generated output bytes. */
const root = resolve(import.meta.dirname, '../..');
const owner = workspacePackages({ root }).find(pkg => pkg.absolute === process.cwd());
if (!owner) throw new Error('Build cwd is not an active workspace package');
const command = owner.name === '@open-marketing/studio' ? 'vite' : 'tsc';
const args = command === 'vite' ? ['build','--sourcemap','--emptyOutDir'] : ['-p','tsconfig.json','--listEmittedFiles'];
const built = spawnSync(command, args, { encoding: 'utf8' });
if (built.status !== 0) { console.error(built.stdout + built.stderr); process.exit(built.status ?? 1); }
if (command === 'vite') console.log(built.stdout);
const digest = sourceDigest({ root, owner });
const emitted = new Set(built.stdout.split('\n').filter(line => line.startsWith('TSFILE: ')).map(line => relative(root,line.slice(8).trim()).replaceAll('\\','/')));
const files = sourceFiles({ root, includeOutput: true }).filter(file => file.startsWith(owner.path + '/dist/') && (command === 'vite' || emitted.has(file)));
if (files.length === 0 || process.versions.node !== '24.2.0') throw new Error('Build output or pinned Node provenance missing');
const outputs = Object.fromEntries(files.map(file => [file,createHash('sha256').update(readFileSync(resolve(root,file))).digest('hex')]));
for (const folder of new Set(files.map(file => dirname(resolve(root,file))))) writeFileSync(resolve(folder,'.om-generated.json'),JSON.stringify({ owner: owner.name, sourceDigest: digest, toolchain: 'Node24.2.0-pnpm10.24.0', compiler: command, outputs },null,2)+'\n');
console.log(`${owner.name}: ${files.length} freshly emitted executable/declaration outputs attested`);
