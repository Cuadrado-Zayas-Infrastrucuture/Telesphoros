import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
function files(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? files(join(directory, entry.name)) : entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts') ? [join(directory, entry.name)] : [],
  );
}
// Named, dynamic, required and bare side-effect imports (`import '…'`) all count.
const importsOf = (source: string) => [...source.matchAll(/(?:from\s*|import\s*\(|require\s*\(|^\s*import\s+)\s*['"]([^'"]+)/gm)].map((m) => m[1]!);
describe('medication capture stays outside clinical processing (MD-6)', () => {
  it('the import matcher sees every import form', () => {
    const source = ["import { a } from '../one';", "import '../two';", "const c = import('../three');", "const d = require('../four');"].join('\n');
    expect(importsOf(source)).toEqual(['../one', '../two', '../three', '../four']);
  });
  it('engine, interpreter and verifier cannot import the medication module or repository', () => {
    const root = resolve(__dirname, '..');
    const paths = [...files(join(root, 'services')), ...files(join(root, 'lab-reports')), join(root, 'ledger/verifier.ts')];
    expect(paths.length).toBeGreaterThan(10);
    for (const path of paths) {
      const source = readFileSync(path, 'utf8');
      const imports = importsOf(source);
      expect(imports.filter((name) => /patient-medications|patient-medication/.test(name))).toEqual([]);
    }
  });
  it('the medication HTTP, service and SQL paths read no genetic result or interpretation', () => {
    const root = resolve(__dirname, '..');
    const paths = [...files(__dirname), join(root, 'storage/postgres/patient-medications.repository.ts')];
    for (const path of paths) {
      const source = readFileSync(path, 'utf8');
      expect(source).not.toMatch(/\b(?:genotype|phenotype|evaluation_results|evaluation_gene_states)\b/i);
      expect(source).not.toMatch(/from ['"][^'"]*(?:lab-reports|services\/engine|services\/interpreter)/);
    }
  });
});
