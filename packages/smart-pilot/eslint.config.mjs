import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import { promiseRules } from "../../scripts/lint/promise-rules.mjs";
export default tseslint.config(
  { ignores: ["dist/**", "dist-ui/**", "openemr/.runtime/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{ts,tsx,js,cjs,mjs}"],
    languageOptions: {
      globals: { ...globals.node, ...globals.browser, ...globals.vitest },
    },
    rules: {
      "@typescript-eslint/no-require-imports": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
    },
  },
  // test/*.test.tsx are outside tsconfig.json (tsc does not check them either), so they get the rules above without types.
  promiseRules(["src/**/*.{ts,tsx}", "ui/**/*.{ts,tsx}"], import.meta.dirname),
);
