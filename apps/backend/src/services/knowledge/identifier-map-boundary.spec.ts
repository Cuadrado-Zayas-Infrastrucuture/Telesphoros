import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

// Spec 039 IK-6: the mapping has no caller yet, and medication code stays out of clinical code. Read from source, so it holds before any
// caller exists.
const BACKEND = resolve(__dirname, '../../..');
const REPO = resolve(BACKEND, '../..');
const SERVICES = join(BACKEND, 'src/services');
const MEDICATIONS = join(BACKEND, 'src/patient-medications');
const LOOKUPS = ['drugForRxcui', 'rxcuiOfDrug', 'geneForHgnc', 'hgncOfGene'] as const;

function files(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? files(join(directory, entry.name)) : /\.(?:ts|js|cjs|mjs)$/.test(entry.name) ? [join(directory, entry.name)] : [],
  );
}

/** Every module a source names: import, import type, export … from, a bare import, require() and import(). */
function importsOf(source: string): string[] {
  return [...source.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)(['"])([^'"]+)\1/g)].map((match) => match[2]!);
}

const importsMapping = (specifier: string) => /(?:^|\/)identifier-map(?:\.[cm]?[jt]s)?$/.test(specifier);
const namedLookups = (source: string) => LOOKUPS.filter((name) => new RegExp(`\\b${name}\\b`).test(source));
/** Whether a module named in `file` is under src/services: a relative path that resolves there, or a bare path through a services folder. */
function reachesServices(file: string, specifier: string): boolean {
  if (!specifier.startsWith('.')) return /(?:^|\/)services(?:\/|$)/.test(specifier);
  const target = resolve(dirname(file), specifier);
  return target === SERVICES || target.startsWith(SERVICES + sep);
}

describe('the identifier map stays a contract with no caller (spec 039 IK-6)', () => {
  it('sees every form a module can be named in (controls)', () => {
    const forms: Record<string, string> = {
      import: "import { a } from './x';",
      'import type': "import type { A } from './x';",
      'export from': "export { a } from './x';",
      'export star': 'export * from "./x";',
      require: "const a = require('./x');",
      'dynamic import': "const a = await import('./x');",
      'bare import': "import './x';",
      'import across lines': "import {\n  a,\n  b,\n} from\n  './x';",
    };
    for (const [form, source] of Object.entries(forms)) expect({ form, imports: importsOf(source) }).toEqual({ form, imports: ['./x'] });
    expect(importsOf("const text = 'from here'; // import nothing")).toEqual([]);
  });

  it('recognises the mapping module, the lookups and a path into services (controls)', () => {
    expect(['./identifier-map', '../knowledge/identifier-map', '../../services/knowledge/identifier-map.ts'].map(importsMapping)).toEqual([true, true, true]);
    expect(['./identifier-map-boundary', './identifier-mapper', './knowledge-set'].map(importsMapping)).toEqual([false, false, false]);
    expect(namedLookups('set.drugForRxcui(id); knowledge.hgncOfGene(gene);')).toEqual(['drugForRxcui', 'hgncOfGene']);
    expect(namedLookups('const drugForRxcuiCount = 1;')).toEqual([]);
    const medicationFile = join(MEDICATIONS, 'patient-medications.service.ts');
    expect(['../services/knowledge/knowledge-set', '../services', 'src/services/knowledge', '../services/../services/x'].map((s) => reachesServices(medicationFile, s))).toEqual([
      true,
      true,
      true,
      true,
    ]);
    expect(
      ['../storage/patients.repository', './patient-medications.service', '@telesphoros/shared-types', '../servicesx/y'].map((s) => reachesServices(medicationFile, s)),
    ).toEqual([false, false, false, false]);
  });

  it('the mapping module imports only the knowledge set and the schema package', () => {
    const source = readFileSync(join(__dirname, 'identifier-map.ts'), 'utf8');
    expect([...new Set(importsOf(source))].sort()).toEqual(['./knowledge-set', '@telesphoros/cpic-schema']);
  });

  it('nothing outside services/knowledge imports the mapping or calls the lookups by identifier', () => {
    const outside = [BACKEND, join(REPO, 'apps/worker')]
      .flatMap((app) => [...files(join(app, 'src')), ...files(join(app, 'test'))])
      .filter((path) => !path.startsWith(__dirname + sep));
    expect(outside.length).toBeGreaterThan(300);
    const offenders = outside.flatMap((path) => {
      const source = readFileSync(path, 'utf8');
      return [
        ...importsOf(source)
          .filter(importsMapping)
          .map((s) => `imports ${s}`),
        ...namedLookups(source).map((name) => `names ${name}`),
      ].map((what) => `${relative(REPO, path)}: ${what}`);
    });
    expect(offenders).toEqual([]);
  });

  it('no medication file imports from services/', () => {
    const medication = files(MEDICATIONS);
    expect(medication.length).toBeGreaterThanOrEqual(3);
    const offenders = medication.flatMap((path) =>
      importsOf(readFileSync(path, 'utf8'))
        .filter((specifier) => reachesServices(path, specifier))
        .map((specifier) => `${relative(REPO, path)}: ${specifier}`),
    );
    expect(offenders).toEqual([]);
  });
});
