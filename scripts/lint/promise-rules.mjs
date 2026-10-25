// Type-aware promise rules, shared by every package's eslint.config so the list lives in one place. A promise that nothing awaits or
// handles fails where nobody sees it: a job that never settles, a test that cannot go red. These rules need type information, so they
// apply only to `files`, which must be covered by the package's tsconfig (the project service reads it from `tsconfigRootDir`).
// A suppression must name the rule and give a reason after `--`; one that no longer suppresses anything is an error, so it cannot
// outlive the code it excused.
export function promiseRules(files, tsconfigRootDir) {
  return {
    files,
    languageOptions: { parserOptions: { projectService: true, tsconfigRootDir } },
    linterOptions: { reportUnusedDisableDirectives: 'error' },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',
    },
  };
}
