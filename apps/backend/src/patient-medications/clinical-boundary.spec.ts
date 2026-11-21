import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
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
  // Spec 044 D8: MD-6 is superseded for the genomic profile only. It is the one place that reads both a patient's medications and their stored
  // results, and it reads them through the two services, never by running anything that produces a result.
  it('only the genomic profile reads both the medication service and the evaluation service', () => {
    const root = resolve(__dirname, '..');
    const both = files(root).filter((path) => {
      const imports = importsOf(readFileSync(path, 'utf8'));
      return imports.some((name) => /patient-medications\.service$/.test(name)) && imports.some((name) => /lab-reports\/evaluations\.service$/.test(name));
    });
    expect(both.map((path) => relative(root, path)).sort()).toEqual([join('genomic-profile', 'genomic-profile.service.ts')]);
  });
  it('the genomic profile imports no engine, adapter, reader, interpreter or knowledge loader', () => {
    const paths = files(resolve(__dirname, '..', 'genomic-profile'));
    expect(paths.length).toBeGreaterThanOrEqual(4);
    for (const path of paths) expect(importsOf(readFileSync(path, 'utf8')).filter((name) => /(?:^|\/)services\//.test(name))).toEqual([]);
  });
});
