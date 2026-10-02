import parser from '@typescript-eslint/parser';
import sonarjs from 'eslint-plugin-sonarjs';
import om from './development/eslint-rules/index.mjs';
/** Exclusions are checked against source provenance, not trusted merely by directory name. */
export const exclusions = ['**/node_modules/**', '**/dist/**', '**/coverage/**', '.git/**', '.tmp/pnpm-store/**', 'AI-Dev-Shop/**'];
export default [
  { ignores: exclusions },
  { files: ['**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}'],
    languageOptions: { parser, parserOptions: { ecmaVersion: 'latest', sourceType: 'module', ecmaFeatures: { jsx: true } } },
    linterOptions: { noInlineConfig: true, reportUnusedDisableDirectives: 'error' },
    plugins: { sonarjs, om },
    rules: { complexity: 'off', 'sonarjs/cognitive-complexity': ['error', 10], 'max-depth': ['error', 3], 'om/control-depth': 'error', 'om/two-object-arguments': 'error', 'om/no-functions-in-component-body': 'error' },
  },
];
