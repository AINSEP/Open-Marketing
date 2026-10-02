import fg from 'fast-glob';
import { readFileSync, realpathSync } from 'node:fs';
import { resolve, dirname, relative } from 'node:path';
import { parse } from 'yaml';
/** Discover movable packages exclusively from the workspace manifest. @complexity O(packages). */
export function workspacePackages({ root = process.cwd() } = {}) {
  const manifest = parse(readFileSync(resolve(root, 'pnpm-workspace.yaml'), 'utf8'));
  return fg.sync(Array.from(manifest.packages).map(glob => `${glob}/package.json`), { cwd: root, ignore: ['**/node_modules/**'], onlyFiles: true }).map(file => {
    const path = dirname(file);
    const pkg = JSON.parse(readFileSync(resolve(root, file), 'utf8'));
    return { ...pkg, path, absolute: realpathSync(resolve(root, path)) };
  });
}
/** All first-party executable source, including parked work and tests. */
export function sourceFiles({ root = process.cwd(), includeOutput = false } = {}) {
  const ignore = ['**/node_modules/**', 'AI-Dev-Shop/**', '.git/**', '.tmp/pnpm-store/**'];
  if (!includeOutput) ignore.push('**/dist/**', '**/coverage/**');
  return fg.sync('**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}', { cwd: root, ignore, dot: true, onlyFiles: true }).map(file => relative(root, resolve(root, file)).replaceAll('\\', '/'));
}
