import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

// Erasable TypeScript only (PLAN §2): no enum, no namespace, no parameter properties.
const erasableOnly = [
  { selector: 'TSEnumDeclaration', message: 'Use a string-literal union instead of enum (erasable TS only).' },
  { selector: 'TSModuleDeclaration[kind="namespace"]', message: 'No namespaces (erasable TS only).' },
  { selector: 'TSParameterProperty', message: 'No parameter properties (erasable TS only).' },
];

export default tseslint.config(
  { ignores: ['dist', 'node_modules', 'coverage', 'supabase/functions/rerank/_vendor'] },
  {
    files: ['**/*.{ts,tsx}'],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: {
      ecmaVersion: 2022,
      globals: { ...globals.browser, ...globals.node },
    },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      '@typescript-eslint/consistent-type-imports': 'error',
      'no-restricted-syntax': ['error', ...erasableOnly],
    },
  },
  {
    // UserContext carries no target; only metrics/ and report/ may see the Scorer (PLAN §3).
    files: ['src/**/*.{ts,tsx}'],
    ignores: ['src/core/metrics/**', 'src/core/report/**', 'src/core/split/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: [{ regex: 'split/scorer(\\.ts)?$', message: 'Only src/core/metrics and src/core/report may import the Scorer.' }] },
      ],
    },
  },
  {
    files: ['supabase/functions/**/*.ts'],
    languageOptions: { globals: { Deno: 'readonly' } },
  },
);
