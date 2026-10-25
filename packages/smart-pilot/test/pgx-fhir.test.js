import fs from 'node:fs';
import crypto from 'node:crypto';
import { validate, validateSchema } from './fhir-r4/validate.js';
import { mapPgxToFhir } from '../src/pgx-fhir.js';

const fixture = () => JSON.parse(fs.readFileSync(new URL('../src/pgx-fixture.json', import.meta.url), 'utf8'));
const binding = {
  tenantId: 'synthetic-office',
  patientId: 'pat_000000000000000000000001',
  fhirPatient: 'patient-a',
  issuer: 'http://127.0.0.1:8301/fhir',
  consent: true,
  interpretable: true,
  contextReady: true,
};
const map = (value = fixture(), context = binding) => mapPgxToFhir(value, context);
const resource = (bundle, type) => bundle.entry.find((e) => e.resource.resourceType === type).resource;

test('core R4 schema accepts the complete collection and rejects malformed resources', () => {
  const bundle = map();
  expect(validate(bundle), JSON.stringify(validateSchema.errors)).toBe(true);
  for (const type of ['DiagnosticReport', 'Observation', 'DocumentReference']) {
    const broken = structuredClone(bundle);
    delete resource(broken, type).status;
    expect(validate(broken)).toBe(false);
  }
  const broken = structuredClone(bundle);
  resource(broken, 'Provenance').recorded = 123;
  expect(validate(broken)).toBe(false);
});

test('maps supplied diplotype/phenotype, exact source bytes and provenance without recommendations', () => {
  const bundle = map();
  expect(bundle.type).toBe('collection');
  expect(bundle.entry.map((e) => e.resource.resourceType)).toEqual(['Patient', 'Device', 'DocumentReference', 'Observation', 'Observation', 'DiagnosticReport', 'Provenance']);
  const observations = bundle.entry.filter((e) => e.resource.resourceType === 'Observation').map((e) => e.resource);
  expect(observations.map((o) => o.valueCodeableConcept.text)).toEqual(['CYP2C19 *1/*2', 'Synthetic intermediate metabolizer']);
  expect(observations[0].code.coding).toEqual([{ system: 'http://loinc.org', code: '84413-4' }]);
  const source = resource(bundle, 'DocumentReference');
  const attachment = source.content[0].attachment;
  const bytes = Buffer.from(attachment.data, 'base64');
  expect(bytes.toString()).toBe('SYNTHETIC ONLY. PGx source report version 2. CYP2C19 *1/*2. Not approved for clinical use.\n');
  expect(attachment.size).toBe(bytes.length);
  expect(source.masterIdentifier.value).toBe('synthetic-source-report/v2');
  expect(attachment.extension.find((e) => e.url.endsWith('/source-sha256')).valueString).toBe(crypto.createHash('sha256').update(bytes).digest('hex'));
  expect(attachment.hash).toBeUndefined(); // R4 hash means SHA-1, not SHA-256.
  expect(attachment.url).toBeUndefined(); // No storage keys, presigned URLs or invented retrieval endpoint.
  expect(resource(bundle, 'DiagnosticReport').identifier.map((i) => i.value)).toEqual(['synthetic-evaluation-2']);
  expect(resource(bundle, 'DiagnosticReport').extension.map((e) => e.valueString)).toEqual(['synthetic-knowledge/2', 'synthetic-acceptance-2']);
  expect(observations[0].identifier).not.toEqual(observations[1].identifier);
  expect(source.extension.map((e) => e.valueString)).toEqual(['synthetic-source-report', 'v2']);
  expect(resource(bundle, 'Device').version).toEqual([{ value: 'synthetic-engine/1' }]);
  expect(resource(bundle, 'Provenance').recorded).toBe('2026-10-02T12:00:00Z');
  expect(JSON.stringify(bundle)).not.toMatch(/MedicationRequest|Task|CarePlan|RiskAssessment|access_token|_history|versionId|encounter/);
  expect(bundle.entry.every((e) => !e.request && e.resource.meta.tag[0].code === 'synthetic-not-for-clinical-use')).toBe(true);
});

test('all references resolve inside the collection to their intended resource type and patient', () => {
  const bundle = map();
  const entries = new Map(bundle.entry.map((e) => [e.fullUrl, e.resource]));
  expect(entries.size).toBe(7);
  const walk = (value) => {
    if (value && typeof value === 'object') {
      if (value.reference) expect(entries.has(value.reference)).toBe(true);
      Object.values(value).forEach(walk);
    }
  };
  walk(bundle);
  const report = resource(bundle, 'DiagnosticReport');
  report.result.forEach((ref) => expect(entries.get(ref.reference).resourceType).toBe('Observation'));
  const provenance = resource(bundle, 'Provenance');
  expect(entries.get(provenance.entity[0].what.reference).resourceType).toBe('DocumentReference');
  expect(entries.get(provenance.agent[0].who.reference).resourceType).toBe('Device');
  for (const { resource: r } of bundle.entry) {
    if (r.subject) {
      const patient = entries.get(r.subject.reference);
      expect(patient.resourceType).toBe('Patient');
      expect(patient.identifier).toEqual([{ system: 'http://127.0.0.1:8301/fhir/Patient', value: 'patient-a' }]);
    }
  }
});

test('snapshots are deterministic, version-specific, independent of list order and scoped to EHR identity', () => {
  const current = map();
  const input = fixture();
  input.versions.reverse();
  expect(map(input)).toEqual(current);
  const historical = fixture();
  historical.selectedEvaluationId = 'synthetic-evaluation-1';
  historical.versions[0].state = 'active';
  historical.versions[0].current = true;
  historical.versions[1].current = false;
  const old = map(historical);
  expect(resource(old, 'DocumentReference').masterIdentifier.value).toBe('synthetic-source-report/v1');
  expect(resource(old, 'DiagnosticReport').id).not.toBe(resource(current, 'DiagnosticReport').id);
  expect(resource(old, 'DocumentReference').id).not.toBe(resource(current, 'DocumentReference').id);
  const reinterpretation = fixture();
  reinterpretation.versions[1].engineVersion = 'synthetic-engine/2';
  expect(resource(map(reinterpretation), 'DiagnosticReport').id).not.toBe(resource(current, 'DiagnosticReport').id);
  expect(resource(map(reinterpretation), 'DocumentReference').id).toBe(resource(current, 'DocumentReference').id);
  expect(resource(map(fixture(), { ...binding, issuer: 'http://127.0.0.1:8302/fhir' }), 'DiagnosticReport').id).not.toBe(resource(current, 'DiagnosticReport').id);
  expect(map()).toEqual(current);
});

test.each([
  [
    'missing selection',
    (x) => {
      x.selectedEvaluationId = 'missing';
    },
  ],
  [
    'old selection',
    (x) => {
      x.selectedEvaluationId = 'synthetic-evaluation-1';
    },
  ],
  [
    'duplicate evaluation',
    (x) => {
      x.versions.push(structuredClone(x.versions[1]));
    },
  ],
  [
    'multiple current versions',
    (x) => {
      x.versions[0].current = true;
    },
  ],
  [
    'no current version',
    (x) => {
      x.versions[1].current = false;
    },
  ],
  [
    'wrong patient',
    (x) => {
      x.versions[1].patientId = 'pat_000000000000000000000002';
    },
  ],
  [
    'wrong tenant',
    (x) => {
      x.versions[1].tenantId = 'other';
    },
  ],
  [
    'cross-patient history',
    (x) => {
      x.versions[0].patientId = 'pat_000000000000000000000002';
    },
  ],
  [
    'retraction',
    (x) => {
      x.versions[1].state = 'retracted';
    },
  ],
  [
    'supersession',
    (x) => {
      x.versions[1].state = 'superseded';
    },
  ],
  [
    'held',
    (x) => {
      x.versions[1].disposition = 'held';
    },
  ],
  [
    'dispute',
    (x) => {
      x.versions[1].activeDisputes = 1;
    },
  ],
  [
    'rejected capture',
    (x) => {
      x.versions[1].acceptance.decision = 'rejected';
    },
  ],
  [
    'stale acceptance',
    (x) => {
      x.versions[1].acceptance.current = false;
    },
  ],
  [
    'unversioned source',
    (x) => {
      delete x.versions[1].source.versionId;
    },
  ],
  [
    'wrong digest',
    (x) => {
      x.versions[1].source.sha256 = '0'.repeat(64);
    },
  ],
  [
    'source version conflict',
    (x) => {
      x.versions[1].source.versionId = 'v1';
    },
  ],
  [
    'arbitrary source bytes',
    (x) => {
      x.versions[1].source.text = 'not a synthetic fixture';
    },
  ],
  [
    'missing knowledge version',
    (x) => {
      delete x.versions[1].knowledgeSetId;
    },
  ],
  [
    'missing engine version',
    (x) => {
      delete x.versions[1].engineVersion;
    },
  ],
  [
    'missing diplotype',
    (x) => {
      delete x.versions[1].genes[0].diplotype;
    },
  ],
  [
    'clinical approval',
    (x) => {
      x.versions[1].clinicalUse = 'approved';
    },
  ],
  [
    'actionable result',
    (x) => {
      x.versions[1].actionable = true;
    },
  ],
])('withholds %s without fallback or partial source disclosure', (_name, mutate) => {
  expect(map()).not.toBeNull();
  const input = fixture();
  mutate(input);
  expect(map(input)).toBeNull();
});
test.each(['consent', 'interpretable', 'contextReady'])('withholds when %s is false', (gate) => {
  expect(map()).not.toBeNull();
  expect(map(fixture(), { ...binding, [gate]: false })).toBeNull();
});
test('legacy registrations do not fabricate a versioned PGx result', () => {
  expect(map()).not.toBeNull();
  expect(mapPgxToFhir(undefined, binding)).toBeNull();
  expect(mapPgxToFhir({ profile: [{ gene: 'CYP2C19', result: 'label' }] }, binding)).toBeNull();
});
