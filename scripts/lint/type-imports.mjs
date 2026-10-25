// An import used only as a type is written `import type`, on its own line (the style every package already uses), so a reader and the
// compilers see that it has no runtime effect. Shared by every package's eslint.config so the setting lives in one place.
// Where decorator metadata is on (the backend), the rule must run with type information (promise-rules.mjs gives it): it then reads
// emitDecoratorMetadata from the tsconfig and leaves files with decorators alone, because a constructor parameter's class is a runtime
// value there and `import type` would erase it and break dependency injection.
export function typeImports(files) {
  return {
    files,
    rules: {
      // `typeof import('…')` stays allowed: module mocks type `requireActual` and `importOriginal` with it, and it imports nothing.
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports', fixStyle: 'separate-type-imports', disallowTypeAnnotations: false }],
    },
  };
}
