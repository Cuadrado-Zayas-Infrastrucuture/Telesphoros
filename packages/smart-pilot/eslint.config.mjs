import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
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
);
