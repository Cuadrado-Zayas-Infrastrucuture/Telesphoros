import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import jsxA11y from 'eslint-plugin-jsx-a11y';

// Tailwind arbitrary values (w-[13px], [mask-type:alpha], [&>svg]:x) bypass the design tokens
// in src/styles/tokens.css. Ban them so every value comes from the token system.
const ARBITRARY = '(^|\\s)([a-z0-9:!&>_*-]+-)?\\[[^\\]\\s]+\\]';
const message =
  'Arbitrary Tailwind values bypass the design tokens. Add a token in src/styles/tokens.css and use its utility instead.';

export default tseslint.config(
  { ignores: ['dist', 'dist-e2e', 'coverage', 'test-results', 'playwright-report'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  jsxA11y.flatConfigs.recommended,
  reactHooks.configs.flat.recommended,
  {
    files: ['**/*.{ts,tsx,js,mjs}'],
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
  },
  {
    files: ['src/**/*.{ts,tsx}'],
    ignores: ['src/**/*.test.{ts,tsx}'],
    rules: {
      'no-restricted-syntax': [
        'error',
        { selector: `Literal[value=/${ARBITRARY}/]`, message },
        { selector: `TemplateElement[value.raw=/${ARBITRARY}/]`, message },
      ],
    },
  },
);
