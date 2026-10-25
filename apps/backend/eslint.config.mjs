import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import { promiseRules } from '../../scripts/lint/promise-rules.mjs';

export default tseslint.config(
  { ignores: ['dist', 'coverage'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,js,mjs}'],
    languageOptions: { globals: { ...globals.node, ...globals.jest } },
  },
  promiseRules(['src/**/*.ts', 'test/**/*.ts'], import.meta.dirname),
  {
    // Request paths log through pino only (redacted, structured). Never console.
    files: ['src/**/*.ts'],
    rules: {
      'no-console': 'error',
      // An error's message never goes into a log line: drivers and SDKs put values, host names and user names in it. Log the error object
      // instead; the logger keeps its class and code only (logger-options.ts, audit finding INF-10).
      'no-restricted-syntax': [
        'error',
        {
          selector: "CallExpression[callee.property.name=/^(log|warn|error|debug|verbose|fatal|info|trace)$/][callee.object.name=/[Ll]ogger$/] MemberExpression[property.name='message']",
          message: 'Do not log an error message (INF-10): pass the error object, and the logger keeps its class and code.',
        },
        {
          selector: "CallExpression[callee.property.name=/^(log|warn|error|debug|verbose|fatal|info|trace)$/][callee.object.property.name=/[Ll]ogger$/] MemberExpression[property.name='message']",
          message: 'Do not log an error message (INF-10): pass the error object, and the logger keeps its class and code.',
        },
      ],
    },
  },
);
