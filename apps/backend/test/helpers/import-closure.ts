import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, normalize, relative } from 'node:path';

/**
 * The files an entry point can load, found by reading import statements (not by running anything). Paths are relative to `apps/backend` and may begin
 * with `../` when an import leaves it (the worker lives beside the backend). Packages are the bare specifiers, `node:` ones included.
 *
 * Type-only imports are skipped, because the compiler removes them; every other form is followed, including `export ... from`, `require()` and `import()`.
 * Conservative on purpose: an import inside a comment is skipped, anything else that looks like an import is followed.
 */
export interface ImportClosure {
  files: Set<string>;
  packages: Set<string>;
  unresolved: string[];
}

export type SourceReader = (path: string) => string | undefined;

export const BACKEND_ROOT = join(__dirname, '..', '..');

export const diskReader: SourceReader = (path) => {
  const full = join(BACKEND_ROOT, path);
  return existsSync(full) ? readFileSync(full, 'utf8') : undefined;
};

const STATIC = /(?:^|[;\n])\s*(?:import|export)\s+(?!type\b)(?:[^;'"]*?\sfrom\s+)?['"]([^'"]+)['"]/g;
const CALLED = /\b(?:require|import)\(\s*['"]([^'"]+)['"]\s*\)/g;

export function specifiersOf(source: string): string[] {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const found: string[] = [];
  for (const pattern of [STATIC, CALLED]) for (const match of code.matchAll(pattern)) found.push(match[1]!);
  return found;
}

function resolveLocal(from: string, specifier: string, read: SourceReader): string | undefined {
  const base = normalize(join(dirname(from), specifier));
  for (const candidate of [`${base}.ts`, join(base, 'index.ts'), base.endsWith('.ts') ? base : '']) {
    if (candidate && read(candidate) !== undefined) return relative('.', candidate);
  }
  return undefined;
}

export function importClosure(entry: string, read: SourceReader = diskReader): ImportClosure {
  const files = new Set<string>();
  const packages = new Set<string>();
  const unresolved: string[] = [];
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (files.has(file)) continue;
    const source = read(file);
    if (source === undefined) {
      unresolved.push(file);
      continue;
    }
    files.add(file);
    for (const specifier of specifiersOf(source)) {
      if (specifier.startsWith('.')) {
        const target = resolveLocal(file, specifier, read);
        if (target) queue.push(target);
        else unresolved.push(`${file} -> ${specifier}`);
      } else {
        packages.add(specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0]!);
      }
    }
  }
  return { files, packages, unresolved };
}
