import parser from '@typescript-eslint/parser';
import { ESLint } from 'eslint';
import { readFileSync } from 'node:fs';
import { sourceFiles } from './workspace.mjs';
import { outputIntegrity, pluginClientIntegrity } from './output-integrity.mjs';
import { fileURLToPath } from 'node:url';
/** Reject inline controls even when ESLint itself treats them as inert.
 * File extension selects JSX syntax; omitted filenames retain TypeScript parsing.
 * @complexity O(source bytes) time/space; invalid syntax throws before lint can pass.
 */
export function sourceIntegrity({ source, file = 'virtual.ts' }) {
  const ast = parser.parse(source, { filePath: file, comment: true, ecmaFeatures: { jsx: /\.[jt]sx$/.test(file) } });
  return ast.comments.some(comment => /eslint-(?:disable|enable)|istanbul ignore|c8 ignore|@ts-nocheck/.test(comment.value));
}
/** Keep all first-party source; only integrity-verified prebuilt plugin client JS is exempt.
 * Plugin server code, TypeScript, parked source and unversioned files keep every lint gate.
 * @example lintSources({ root: process.cwd() });
 */
export function lintSources({ root }) {
  const files = []; const failures = [];
  for (const file of sourceFiles({ root })) {
    const checked = pluginClientIntegrity({ root, file });
    failures.push(...checked.failures);
    if (!checked.excluded) files.push(file);
  }
  return { files, failures };
}
/** Resolve each file's effective gates; no extension or untracked source can disappear. */
export async function lintWorkspace({ cwd = process.cwd() } = {}) {
  const eslint = new ESLint({ cwd });
  const { files, failures } = lintSources({ root: cwd });
  failures.push(...outputIntegrity({ root: cwd }));
  for (const file of files) {
    const config = await eslint.calculateConfigForFile(file);
    if (!config || config.rules['sonarjs/cognitive-complexity'][0] !== 2 || config.rules['sonarjs/cognitive-complexity'][1] !== 10) failures.push(`${file}: invalid effective gate`);
    if (sourceIntegrity({ source: readFileSync(`${cwd}/${file}`, 'utf8'), file })) failures.push(`${file}: forbidden inline directive`);
  }
  const results = await eslint.lintFiles(files);
  failures.push(...results.flatMap(result => result.messages.map(message => `${result.filePath}:${message.line}: ${message.ruleId}: ${message.message}`)));
  return failures;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const failures = await lintWorkspace();
  console.log(failures.join('\n') || 'OM lint and effective-config integrity PASS');
  process.exitCode = failures.length ? 1 : 0;
}
