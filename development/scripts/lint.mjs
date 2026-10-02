import parser from '@typescript-eslint/parser';
import { ESLint } from 'eslint';
import { readFileSync } from 'node:fs';
import { sourceFiles } from './workspace.mjs';
import { outputIntegrity } from './output-integrity.mjs';
import { fileURLToPath } from 'node:url';
/** Reject inline controls even when ESLint itself treats them as inert. */
export function sourceIntegrity({ source }) {
  const ast = parser.parse(source, { comment: true, ecmaFeatures: { jsx: true } });
  return ast.comments.some(comment => /eslint-(?:disable|enable)|istanbul ignore|c8 ignore|@ts-nocheck/.test(comment.value));
}
/** Resolve each file's effective gates; no extension or untracked source can disappear. */
export async function lintWorkspace({ cwd = process.cwd() } = {}) {
  const eslint = new ESLint({ cwd });
  const files = sourceFiles({ root: cwd });
  const failures = outputIntegrity({ root: cwd });
  for (const file of files) {
    const config = await eslint.calculateConfigForFile(file);
    if (!config || config.rules['sonarjs/cognitive-complexity'][0] !== 2 || config.rules['sonarjs/cognitive-complexity'][1] !== 10) failures.push(`${file}: invalid effective gate`);
    if (sourceIntegrity({ source: readFileSync(`${cwd}/${file}`, 'utf8') })) failures.push(`${file}: forbidden inline directive`);
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
