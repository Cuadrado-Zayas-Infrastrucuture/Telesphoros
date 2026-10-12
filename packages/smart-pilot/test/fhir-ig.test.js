import { test, expect } from 'vitest';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { mapPgxToFhir, buildPgxCollection } from '../src/pgx-fhir.ts';
import { terminologyIssues } from './fhir-ig/terminology.js';
const binding = { tenantId: 'synthetic-office', patientId: 'pat_000000000000000000000001', fhirPatient: 'patient-a', issuer: 'http://127.0.0.1:8301/fhir', consent: true, interpretable: true, contextReady: true };
const fixture = JSON.parse(fs.readFileSync(new URL('../src/pgx-fixture.json', import.meta.url), 'utf8'));
const build = () => mapPgxToFhir(structuredClone(fixture), binding);
const profile = name => JSON.parse(gunzipSync(fs.readFileSync(new URL(`./fhir-ig/published/${name}.json.gz`, import.meta.url))));
// Independent published patterns, supplemented by the actual HL7 validator in CI.
function patternIssues(bundle) {
  const issues = [];
  for (const { resource } of bundle.entry) {
    const name = resource.resourceType === 'DiagnosticReport' ? 'genomic-report' : resource.id.startsWith('genotype-') ? 'genotype' : null;
    if (!name) continue;
    const p = profile(name);
    if (!resource.meta.profile?.includes(`${p.url}|${p.version}`)) issues.push('profile');
    for (const element of p.snapshot.element) {
      if (element.id === `${resource.resourceType}.code`) {
        for (const c of element.patternCodeableConcept.coding)
          if (!resource.code.coding.some(v => v.system === c.system && v.code === c.code)) issues.push('code');
      }
      if (element.path === `${resource.resourceType}.category.coding` && element.patternCoding) {
        const c = element.patternCoding;
        if (resource.category?.filter(v => v.coding?.length === 1 && v.coding[0].system === c.system && v.coding[0].code === c.code).length !== 1) issues.push('category');
      }
    }
  }
  return issues;
}
test('exported genotype and report match pinned IG patterns; all emitted codes are in the finite terminology contract', () => {
  const bundle = build();
  expect(patternIssues(bundle)).toEqual([]);
  expect(terminologyIssues(bundle)).toEqual([]);
  const phenotype = bundle.entry.find(e => e.resource.id.startsWith('phenotype-')).resource;
  expect(phenotype.meta.profile).toBeUndefined();
  expect(phenotype.valueCodeableConcept).toEqual({ text: 'Synthetic intermediate metabolizer' });
});
for (const target of ['genotype', 'pgx']) {
  for (const field of ['category', 'code', 'profile']) test(`rejects ${target} missing/wrong ${field} (valid control first)`, () => {
    const b = build(); expect(patternIssues(b)).toEqual([]);
    const r = b.entry.find(e => e.resource.id.startsWith(`${target}-`)).resource;
    if (field === 'profile') delete r.meta.profile;
    else if (field === 'category') r.category = [];
    else r.code.coding[0].code = 'not-a-loinc-code';
    expect(patternIssues(b)).toContain(field);
  });
}
for (const field of ['system', 'code']) test(`unknown terminology ${field} fails even though core JSON accepts strings`, () => {
  const b = build(); expect(terminologyIssues(b)).toEqual([]);
  b.entry.find(e => e.resource.resourceType === 'DiagnosticReport').resource.code.coding[0][field] = 'unknown';
  expect(terminologyIssues(b).length).toBeGreaterThan(0);
});
test('phenotype-only stored state does not invent a genotype or claim an implication profile', () => {
  const b = buildPgxCollection({ ...fixture.versions[1], genes: [{ gene: 'CYP2D6', diplotype: null, phenotype: 'Synthetic unknown' }] }, binding,
    { kind: 'stored-reference', reportId: 'synthetic-source', sha256: 'a'.repeat(64) });
  expect(b.entry.filter(e => e.resource.id.startsWith('genotype-'))).toHaveLength(0);
  expect(patternIssues(b)).toEqual([]); expect(terminologyIssues(b)).toEqual([]);
});
test('profile revision changes affected snapshot IDs but preserves unchanged source identity', () => {
  const b = build();
  expect(b.entry.find(e => e.resource.resourceType === 'DiagnosticReport').resource.id).not.toBe('pgx-9b4fc0386a9902515c260026711af3ae05dca39e8ab03bad');
  expect(b.entry.find(e => e.resource.id.startsWith('genotype-')).resource.id).not.toBe('genotype-9b4fc0386a9902515c260026711af3ae05dca39e8ab03bad');
  expect(b.entry.find(e => e.resource.resourceType === 'DocumentReference').resource.id).toBe('source-72faca654ee32bb939bc14bd57d1cd11660d15307468edba');
});

test('published profile bytes match the reviewed immutable snapshot pins', () => {
  for (const [name, expected] of Object.entries({ genotype: '07b716b45acb5867bc1e58b0a1c51156befb47e19ccb74910ae6e863fc902f25', 'genomic-report': 'c7deb5b92af3eb72eeca9145f913adcdc7e83345a4052b4c449fc8d95979bcff' })) {
    const bytes = gunzipSync(fs.readFileSync(new URL(`./fhir-ig/published/${name}.json.gz`, import.meta.url)));
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(expected);
    expect(JSON.parse(bytes).version).toBe('3.0.0');
  }
});
