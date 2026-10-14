import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist', 'coverage'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,js,mjs}'],
    languageOptions: { globals: { ...globals.node } },
  },
  {
    // The worker logs through src/log.ts only: a fixed set of fields, never a payload value.
    files: ['src/**/*.ts'],
    rules: { 'no-console': 'error' },
  },
);
