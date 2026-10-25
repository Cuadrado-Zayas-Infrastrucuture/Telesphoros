import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import { promiseRules } from '../../scripts/lint/promise-rules.mjs';

// The queue, registry and retry rules the worker and backend share. Not linted before 2026-10-24.
export default tseslint.config(
  { ignores: ['dist', 'coverage'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,js,mjs}'],
    languageOptions: { globals: { ...globals.node } },
  },
  promiseRules(['src/**/*.ts'], import.meta.dirname),
);
