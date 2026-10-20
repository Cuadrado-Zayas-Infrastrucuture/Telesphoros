import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
export default tseslint.config({ ignores: ['dist/**'] }, js.configs.recommended, ...tseslint.configs.recommended, { files: ['**/*.{ts,mts,mjs}'], languageOptions: { globals: globals.node } }, { files: ['src/**/*.ts'], rules: { 'no-console': 'error' } });
