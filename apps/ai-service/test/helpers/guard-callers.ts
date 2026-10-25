import { readdirSync, readFileSync } from 'node:fs';
import { posix, resolve, sep } from 'node:path';
import ts from 'typescript';

/** All .ts files under src, keyed by path below src with forward slashes. */
export function srcFiles(root: string): Record<string, string> {
  const dir = resolve(root, 'src'), out: Record<string, string> = {};
  for (const f of readdirSync(dir, { recursive: true, encoding: 'utf8' })) if (f.endsWith('.ts')) out[f.split(sep).join(posix.sep)] = readFileSync(resolve(dir, f), 'utf8');
  return out;
}
const ast = (path: string, source: string) => ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
/** Names exported by a file. */
export function exportsOf(path: string, source: string): string[] {
  const names: string[] = [];
  ast(path, source).forEachChild(n => {
    if (ts.isVariableStatement(n) && n.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword)) for (const d of n.declarationList.declarations) if (ts.isIdentifier(d.name)) names.push(d.name.text);
    if ((ts.isFunctionDeclaration(n) || ts.isClassDeclaration(n)) && n.name && n.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword)) names.push(n.name.text);
  });
  return names;
}
/** True when `symbol` is referenced as an identifier in `source` (a call, a reference or an import). */
export function mentions(path: string, source: string, symbol: string): boolean {
  let found = false;
  const visit = (n: ts.Node) => { if (ts.isIdentifier(n) && n.text === symbol) found = true; ts.forEachChild(n, visit); };
  visit(ast(path, source));
  return found;
}
/** Guards whose symbol no source file other than the defining one mentions: a guard with no production caller (R2). */
export function guardsWithoutCaller(files: Record<string, string>, guards: Readonly<Record<string, { symbol: string; module: string }>>): string[] {
  return Object.entries(guards).filter(([, g]) => !Object.entries(files).some(([path, source]) => path !== g.module && mentions(path, source, g.symbol))).map(([name]) => name);
}
