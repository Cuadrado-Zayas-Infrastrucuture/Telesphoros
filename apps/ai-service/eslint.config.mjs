import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import { promiseRules } from '../../scripts/lint/promise-rules.mjs';
import { typeImports } from '../../scripts/lint/type-imports.mjs';
export default tseslint.config({ ignores: ['dist/**'] }, js.configs.recommended, ...tseslint.configs.recommended, { files: ['**/*.{ts,mts,mjs}'], languageOptions: { globals: globals.node } }, { files: ['src/**/*.ts'], rules: { 'no-console': 'error' } }, promiseRules(['src/**/*.ts', 'durable/**/*.ts', 'test/**/*.ts'], import.meta.dirname), typeImports(['**/*.{ts,mts}']));
