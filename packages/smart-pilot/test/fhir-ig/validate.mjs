// Only generated synthetic fixtures are accepted. No URL/file input or remote terminology submission.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { mapPgxToFhir, buildPgxCollection } from '../../dist/pgx-fhir.js';
import { terminologyIssues } from './terminology.js';
const here = dirname(fileURLToPath(import.meta.url));
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
async function artifact(name, url, expected, override) {
  const path = override || join(tmpdir(), name);
  if (!existsSync(path)) {
    const r = await fetch(url, { signal: AbortSignal.timeout(180000) });
    assert.ok(r.ok, `download failed: ${name}`);
    const bytes = Buffer.from(await r.arrayBuffer());
    assert.equal(sha(bytes), expected, `artifact checksum: ${name}`);
    writeFileSync(path, bytes);
  }
  assert.equal(sha(readFileSync(path)), expected, `artifact checksum: ${name}`);
  return path;
}
const jar = await artifact(
  'fhir-validator-7.0.1.jar',
  'https://github.com/hapifhir/org.hl7.fhir.core/releases/download/7.0.1/validator_cli.jar',
  '1178b6a3a3fe98d9cd9545cadee505274967332466001d857e4d8bed7138a5bc',
  process.env.FHIR_VALIDATOR_JAR,
);
const ig = await artifact(
  'genomics-reporting-3.0.0.tgz',
  'https://hl7.org/fhir/uv/genomics-reporting/STU3/package.tgz',
  '7a42cdfae8d47f0d39a2ad5c46ec9028ede4848655600e7deaff440b44d4d221',
);
const output = process.env.FHIR_IG_OUTPUT ? resolve(process.env.FHIR_IG_OUTPUT) : mkdtempSync(join(tmpdir(), 'synthetic-fhir-ig-'));
mkdirSync(output, { recursive: true });
// Remove only the prior generated summary so a failed rerun cannot look successful.
rmSync(join(output, 'summary.json'), { force: true });
const fixture = JSON.parse(readFileSync(join(here, '../../src/pgx-fixture.json'), 'utf8'));
const binding = {
  tenantId: 'synthetic-office',
  patientId: 'pat_000000000000000000000001',
  fhirPatient: 'patient-a',
  issuer: 'http://127.0.0.1:8301/fhir',
  consent: true,
  interpretable: true,
  contextReady: true,
};
const control = mapPgxToFhir(fixture, binding);
assert.ok(control);
const snapshot = {
  ...fixture.versions[1],
  captureId: 'synthetic-capture',
  correctionRevision: 'b'.repeat(64),
  genes: [
    { gene: 'CYP2C19', diplotype: '*1/*2', phenotype: 'Synthetic intermediate metabolizer' },
    { gene: 'CYP2D6', diplotype: null, phenotype: 'Synthetic unknown' },
  ],
};
const pdf = Buffer.from('%PDF-1.4\n% SYNTHETIC VALIDATOR FIXTURE ONLY\n%%EOF\n');
const positives = [
  control,
  buildPgxCollection(snapshot, binding, { kind: 'stored-reference', reportId: 'synthetic-report', sha256: 'a'.repeat(64) }),
  buildPgxCollection(snapshot, binding, {
    kind: 'stored-pdf',
    reportId: 'synthetic-report',
    versionId: 'synthetic-version',
    sha256: sha(pdf),
    data: pdf.toString('base64'),
    size: pdf.length,
  }),
  buildPgxCollection({ ...snapshot, genes: snapshot.genes.slice(1) }, binding, { kind: 'stored-reference', reportId: 'synthetic-report', sha256: 'a'.repeat(64) }),
];
for (const b of positives) assert.deepEqual(terminologyIssues(b), []);
// These errors are legal core JSON but violate the published IG or local extension type.
const negatives = [
  (b) => {
    delete b.entry.find((e) => e.resource.id.startsWith('genotype-')).resource.category;
  },
  (b) => {
    b.entry.find((e) => e.resource.resourceType === 'DiagnosticReport').resource.code.coding[0].code = '84413-4';
  },
  (b) => {
    const r = b.entry.find((e) => e.resource.id.startsWith('genotype-')).resource;
    delete r.valueCodeableConcept;
    r.valueString = 'CYP2C19 *1/*2';
  },
  (b) => {
    const e = b.entry.find((e) => e.resource.resourceType === 'DiagnosticReport').resource.extension[0];
    delete e.valueString;
    e.valueInteger = 1;
  },
].map((mutate) => {
  const b = structuredClone(control);
  mutate(b);
  return b;
});
function validate(name, bundles, expectErrors) {
  const dir = join(output, name);
  mkdirSync(dir, { recursive: true });
  const files = bundles.map((b, i) => {
    const p = join(dir, `${i}.json`);
    writeFileSync(p, JSON.stringify(b));
    return p;
  });
  const resultFile = join(output, `${name}-outcome.json`);
  // Only this generated outcome is replaced; stale results must never satisfy a new run.
  rmSync(resultFile, { force: true });
  const java = process.env.JAVA_HOME ? join(process.env.JAVA_HOME, 'bin/java') : 'java';
  const result = spawnSync(java, ['-Xmx2g', '-jar', jar, ...files, '-version', '4.0.1', '-ig', ig, '-ig', join(here, 'definitions'), '-tx', 'n/a', '-output', resultFile], {
    encoding: 'utf8',
    timeout: 360000,
    maxBuffer: 16 * 1024 * 1024,
  });
  writeFileSync(join(output, `${name}.log`), `${result.stdout || ''}\n${result.stderr || ''}`);
  assert.ifError(result.error);
  assert.ok(existsSync(resultFile), `validator did not produce ${name} outcome; see ${output}`);
  const report = JSON.parse(readFileSync(resultFile, 'utf8'));
  const outcomes = report.resourceType === 'Bundle' ? report.entry.map((e) => e.resource) : [report];
  assert.equal(outcomes.length, bundles.length, 'every supplied fixture must have a result');
  const counts = outcomes.map((o) => {
    assert.equal(o.resourceType, 'OperationOutcome');
    return { errors: (o.issue || []).filter((i) => ['error', 'fatal'].includes(i.severity)).length, warnings: (o.issue || []).filter((i) => i.severity === 'warning').length };
  });
  assert.ok(
    counts.every((c) => (expectErrors ? c.errors > 0 : c.errors === 0)),
    `${name} error expectations failed; see ${resultFile}`,
  );
  // Pinned CLI returns zero after writing outcomes, even when those contain errors.
  // Execution success is required; conformance is decided by the parsed issues above.
  assert.equal(result.status, 0, 'validator execution failed');
  if (expectErrors) {
    const reasons = ['Observation.category', '51969-4', 'CodeableConcept', 'knowledge-set-id'];
    outcomes.forEach((o, i) =>
      assert.ok(
        o.issue.some((issue) => ['error', 'fatal'].includes(issue.severity) && issue.details?.text?.includes(reasons[i])),
        `negative ${i} must fail for its intended reason`,
      ),
    );
  }
  return counts;
}
const results = {
  validator: '7.0.1',
  fhir: '4.0.1',
  ig: '3.0.0',
  terminology: 'finite exporter code contract; remote server disabled',
  positive: validate('positive', positives, false),
  negative: validate('negative', negatives, true),
};
writeFileSync(join(output, 'summary.json'), JSON.stringify(results, null, 2));
console.log(`PASS published Genomics IG: ${positives.length} controls, ${negatives.length} rejected defects. Evidence: ${output}`);
