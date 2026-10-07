import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist', 'coverage'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,js,mjs}'],
    languageOptions: { globals: { ...globals.node, ...globals.jest } },
  },
  {
    // Request paths log through pino only (redacted, structured). Never console.
    files: ['src/**/*.ts'],
    rules: { 'no-console': 'error' },
  },
);
