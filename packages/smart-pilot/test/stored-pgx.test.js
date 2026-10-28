import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { createStoredPgxReader } from '../src/stored-pgx.js';
import * as sourcePdf from '../src/source-pdf.js';
import * as client from '../src/client.js';
import { validate, validateSchema } from './fhir-r4/validate.js';

const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const time = '2026-10-11T12:00:00Z';
const clock = () => Date.parse(time);
const clinician = 'Practitioner/clinician-a';
const binding = { tenantId: 'synthetic-office', patientId: 'pat_000000000000000000000001', fhirPatient: 'patient-a', issuer: 'http://127.0.0.1:8301/fhir' };
let config, selection, records, calls, onRead;
const build = () => createStoredPgxReader(config, clock);
const read = () => build()(selection, clinician, binding);
beforeEach(() => {
  const token = jwt.sign(
    {
      sub: 'synthetic-reader',
      iss: 'http://127.0.0.1:4010',
      client_id: 'synthetic-client',
      token_use: 'access',
      exp: clock() / 1000 + 120,
      'cognito:groups': ['tenant:alpha', 'clinician'],
    },
    crypto.randomBytes(32),
  );
  config = {
    mode: 'stored-synthetic',
    apiBaseUrl: 'http://127.0.0.1:3010/api/v1',
    issuer: 'http://127.0.0.1:4010',
    clientId: 'synthetic-client',
    readers: [{ ehrIssuer: binding.issuer, clinician, subject: 'synthetic-reader', tenantId: 'alpha', token }],
  };
  selection = { patientId: uuid(1), label: 'SYN-STORED-1', evaluationId: uuid(3) };
  const decision = { id: uuid(5), captureId: uuid(4), decision: 'accepted', textSha256: 'b'.repeat(64), popplerVersion: 'synthetic/1', note: null, createdAt: time };
  records = {
    '/me': { roles: ['clinician'] },
    [`/patients/${uuid(1)}`]: { id: uuid(1), label: selection.label, createdAt: time, updatedAt: time },
    [`/reports/${uuid(2)}`]: {
      id: uuid(2),
      patientId: uuid(1),
      type: 'lab-pdf',
      filename: 'source.pdf',
      sizeBytes: 123,
      status: 'processed',
      fileUploaded: true,
      contentType: 'application/pdf',
      sha256: 'a'.repeat(64),
      createdAt: time,
      updatedAt: time,
    },
    [`/captures/${uuid(4)}`]: {
      id: uuid(4),
      reportId: uuid(2),
      pdfSha256: 'a'.repeat(64),
      textSha256: 'b'.repeat(64),
      textScalars: 50,
      popplerVersion: 'synthetic/1',
      runner: 'fake',
      createdAt: time,
      latestDecision: decision,
    },
    [`/evaluations/${uuid(3)}`]: {
      id: uuid(3),
      reportId: uuid(2),
      patientId: uuid(1),
      captureId: uuid(4),
      acceptance: { id: uuid(5), decision: 'accepted', current: true },
      disposition: 'evaluated',
      holdCode: null,
      hold: null,
      knowledgeSetId: 'stored-knowledge-digest',
      engineVersion: 'stored-engine-1',
      scope: 'synthetic-test-only/1',
      clinicalUse: 'not-approved',
      actionable: false,
      state: 'active',
      supersededBy: null,
      current: true,
      results: [],
      geneInputs: [],
      geneStates: [{ gene: 'CYP2C19', state: 'canonical', phenotype: 'intermediate metabolizer', diplotype: '*1/*2', activityScore: null, reasonCode: null }],
      corrections: [],
      advisory: { activeDisputes: 0, patientLink: 'verified' },
      createdAt: time,
    },
  };
  calls = [];
  onRead = () => {};
  vi.spyOn(client, 'requestJson').mockImplementation(async (url, options) => {
    const path = new URL(url).pathname.replace('/api/v1', '');
    calls.push({ path, options });
    onRead(path, calls.length);
    if (!records[path]) throw new Error('unavailable');
    return structuredClone(records[path]);
  });
});
afterEach(() => vi.restoreAllMocks());
const evaluation = () => records[`/evaluations/${uuid(3)}`];
const report = () => records[`/reports/${uuid(2)}`];
const capture = () => records[`/captures/${uuid(4)}`];

test('maps authorized stored DTOs through the common R4 builder without fabricated bytes, versions or recommendation text', async () => {
  evaluation().results = [
    {
      id: uuid(9),
      ordinal: 0,
      drug: 'synthetic-drug',
      genes: ['CYP2C19'],
      outcome: 'shown',
      reasonCode: null,
      strength: null,
      citation: null,
      recommendationText: 'DO NOT EXPORT THIS',
      implication: null,
      geneEvidence: null,
    },
  ];
  const result = await read();
  expect(validate(result.bundle), JSON.stringify(validateSchema.errors)).toBe(true);
  expect(result.expires).toBe(clock() + 120000);
  const resources = result.bundle.entry.map((e) => e.resource);
  const document = resources.find((r) => r.resourceType === 'DocumentReference');
  const attachment = document.content[0].attachment;
  expect(attachment).toMatchObject({ contentType: 'application/pdf', extension: [{ valueString: 'a'.repeat(64) }] });
  expect(attachment.data).toBeUndefined();
  expect(attachment.url).toBeUndefined();
  expect(attachment.hash).toBeUndefined();
  expect(document.extension.some((e) => e.url.endsWith('source-version-id'))).toBe(false);
  expect(resources.find((r) => r.resourceType === 'DiagnosticReport').identifier[0].value).toBe(uuid(3));
  expect(resources.find((r) => r.resourceType === 'DiagnosticReport').extension.map((e) => e.valueString)).toContain(uuid(4));
  expect(JSON.stringify(result)).not.toContain('DO NOT EXPORT THIS');
  expect(JSON.stringify(result.bundle)).not.toContain(uuid(9)); // the stored result reference (spec 006 D01a) is not exported either
  expect(JSON.stringify(result)).not.toContain(config.readers[0].token);
  expect(calls).toHaveLength(9);
  expect(calls.every((c) => c.options.token === config.readers[0].token && !c.options.form)).toBe(true);
});
test('does not infer a genotype when the stored canonical phenotype has no diplotype', async () => {
  evaluation().geneStates[0].diplotype = null;
  const result = await read();
  expect(validate(result.bundle)).toBe(true);
  expect(result.bundle.entry.filter((e) => e.resource.resourceType === 'Observation')).toHaveLength(1);
  expect(JSON.stringify(result.bundle)).not.toContain('84413-4');
});
test('multiple genes get unique identifiers and closed references', async () => {
  evaluation().geneStates.push({ ...evaluation().geneStates[0], gene: 'CYP2B6', phenotype: 'normal metabolizer', diplotype: '*1/*1' });
  const { bundle } = await read();
  expect(validate(bundle)).toBe(true);
  const entries = new Map(bundle.entry.map((e) => [e.fullUrl, e.resource]));
  expect(entries.size).toBe(9);
  const ids = bundle.entry.filter((e) => e.resource.resourceType === 'Observation').map((e) => JSON.stringify(e.resource.identifier));
  expect(new Set(ids).size).toBe(4);
  const walk = (value) => {
    if (value && typeof value === 'object') {
      if (value.reference) expect(entries.has(value.reference)).toBe(true);
      Object.values(value).forEach(walk);
    }
  };
  walk(bundle);
});
test.each([
  [
    'wrong principal',
    () => {
      config.readers[0].subject = 'another-user';
    },
  ],
  [
    'wrong tenant',
    () => {
      config.readers[0].tenantId = 'beta';
    },
  ],
  [
    'wrong issuer',
    () => {
      config.issuer = 'http://127.0.0.1:4011';
    },
  ],
  [
    'wrong client',
    () => {
      config.clientId = 'other';
    },
  ],
  [
    'reader-only role',
    () => {
      records['/me'].roles = ['reader'];
    },
  ],
  [
    'patient label mismatch',
    () => {
      records[`/patients/${uuid(1)}`].label = 'SYN-OTHER';
    },
  ],
  [
    'cross-patient evaluation',
    () => {
      evaluation().patientId = uuid(99);
    },
  ],
  [
    'non-synthetic scope',
    () => {
      evaluation().scope = null;
    },
  ],
  [
    'clinical approval',
    () => {
      evaluation().clinicalUse = 'approved';
    },
  ],
  [
    'actionable',
    () => {
      evaluation().actionable = true;
    },
  ],
  [
    'held',
    () => {
      evaluation().disposition = 'held';
    },
  ],
  [
    'retracted',
    () => {
      evaluation().state = 'retracted';
    },
  ],
  [
    'superseded',
    () => {
      evaluation().state = 'superseded';
    },
  ],
  [
    'dispute',
    () => {
      evaluation().advisory.activeDisputes = 1;
    },
  ],
  [
    'patient link not verified',
    () => {
      evaluation().advisory.patientLink = 'unverified';
    },
  ],
  [
    'patient link rejected',
    () => {
      evaluation().advisory.patientLink = 'rejected';
    },
  ],
  [
    'stale acceptance',
    () => {
      evaluation().acceptance.current = false;
    },
  ],
  [
    'rejected acceptance',
    () => {
      evaluation().acceptance.decision = 'rejected';
    },
  ],
  [
    'capture decision changed',
    () => {
      capture().latestDecision.id = uuid(99);
    },
  ],
  [
    'wrong report patient',
    () => {
      report().patientId = uuid(99);
    },
  ],
  [
    'wrong capture report',
    () => {
      capture().reportId = uuid(99);
    },
  ],
  [
    'wrong source digest',
    () => {
      report().sha256 = 'c'.repeat(64);
    },
  ],
  [
    'unverified upload',
    () => {
      report().fileUploaded = false;
    },
  ],
  [
    'unresolved gene',
    () => {
      evaluation().geneStates[0].state = 'unresolved';
    },
  ],
  [
    'missing phenotype',
    () => {
      evaluation().geneStates[0].phenotype = null;
    },
  ],
  [
    'no genes',
    () => {
      evaluation().geneStates = [];
    },
  ],
  [
    'duplicate gene',
    () => {
      evaluation().geneStates.push(evaluation().geneStates[0]);
    },
  ],
])('withholds %s with a successful control', async (_name, mutate) => {
  expect((await read()).bundle.resourceType).toBe('Bundle');
  mutate();
  if (['held', 'dispute', 'patient link not verified', 'patient link rejected', 'stale acceptance', 'rejected acceptance', 'capture decision changed'].includes(_name)) {
    const result = await read();
    expect(result.bundle).toBeNull();
    expect(result.profile).toEqual([]);
  } else await expect(read()).rejects.toThrow();
});
test.each(['/patients/', '/reports/', '/captures/', '/evaluations/'])('refuses %s changes during assembly', async (prefix) => {
  await read();
  calls.length = 0;
  const seen = new Set();
  onRead = (path) => {
    if (!path.startsWith(prefix)) return;
    if (seen.has(path)) records[path].createdAt = '2026-10-12T00:00:00Z';
    seen.add(path);
  };
  await expect(read()).rejects.toThrow('stored_context_changed');
});
test('refuses a backend credential that expires during closing reads', async () => {
  let now = clock();
  const reader = createStoredPgxReader(config, () => now);
  await reader(selection, clinician, binding);
  calls.length = 0;
  onRead = (_p, count) => {
    if (count === 9) now += 121000;
  };
  await expect(reader(selection, clinician, binding)).rejects.toThrow('stored_token_expired');
});
test('unmapped clinician makes no backend request', async () => {
  await expect(build()(selection, 'Practitioner/other', binding)).rejects.toThrow('stored_reader_unavailable');
  expect(calls).toHaveLength(0);
});
test('unavailable API never maps a static substitute', async () => {
  await read();
  vi.mocked(client.requestJson).mockRejectedValue(new Error('unavailable'));
  await expect(read()).rejects.toThrow('unavailable');
});
test.each(['https://example.com/api/v1', 'http://127.0.0.1:3010/other', 'http://127.0.0.1:3010/api/v1?override=1'])('rejects unsafe API base %s', (url) => {
  config.apiBaseUrl = url;
  expect(build).toThrow();
  expect(calls).toHaveLength(0);
});

test('the same clinician identifier from a different EHR cannot use the credential', async () => {
  await expect(build()(selection, clinician, { ...binding, issuer: 'http://127.0.0.1:8302/fhir' })).rejects.toThrow('stored_reader_unavailable');
  expect(calls).toHaveLength(0);
});

test('configured PDF retrieval preserves the verified version and bytes through the R4 builder', async () => {
  const data = Buffer.from('%PDF-1.4\nSYNTHETIC ONLY\n%%EOF\n').toString('base64');
  config.sourcePdf = { storageOrigin: 'http://127.0.0.1:5555' };
  records[`/reports/${uuid(2)}/download-url`] = { url: 'opaque-test-only', expiresAt: time };
  const pdf = vi.spyOn(sourcePdf, 'readSourcePdf').mockResolvedValue({ versionId: 'version-1', sha256: report().sha256, data, size: 30, expires: clock() + 30000 });
  const result = await read();
  expect(validate(result.bundle), JSON.stringify(validateSchema.errors)).toBe(true);
  const document = result.bundle.entry.find((e) => e.resource.resourceType === 'DocumentReference').resource;
  expect(document.extension.find((e) => e.url.endsWith('source-version-id')).valueString).toBe('version-1');
  expect(document.content[0].attachment.data).toBe(data);
  expect(document.content[0].attachment.url).toBeUndefined();
  expect(result.expires).toBe(clock() + 30000);
  expect(calls).toHaveLength(10);
  expect(pdf).toHaveBeenCalledWith(
    records[`/reports/${uuid(2)}/download-url`],
    config.sourcePdf.storageOrigin,
    { sizeBytes: report().sizeBytes, sha256: capture().pdfSha256 },
    expect.any(Function),
  );
  pdf.mockRejectedValue(new Error('source_pdf_withheld'));
  await expect(read()).rejects.toThrow('source_pdf_withheld');
});
test('a correction during PDF download withholds the entire preview', async () => {
  config.sourcePdf = { storageOrigin: 'http://127.0.0.1:5555' };
  records[`/reports/${uuid(2)}/download-url`] = {};
  const pdf = vi.spyOn(sourcePdf, 'readSourcePdf').mockImplementation(async () => {
    evaluation().state = 'retracted';
    return { versionId: 'v1', sha256: report().sha256, data: 'JVBERi0=', size: 5, expires: clock() + 30000 };
  });
  await expect(read()).rejects.toThrow('stored_context_changed');
  expect(pdf).toHaveBeenCalledOnce();
});
test.each(['http://127.0.0.1:5555/path', 'https://example.com', 'http://127.0.0.1:5555?query=1'])('rejects invalid configured storage origin %s', (origin) => {
  config.sourcePdf = { storageOrigin: origin };
  expect(build).toThrow();
});
test('link expiry during closing state reads withholds bytes even while the backend credential remains valid', async () => {
  config.sourcePdf = { storageOrigin: 'http://127.0.0.1:5555' };
  records[`/reports/${uuid(2)}/download-url`] = {};
  vi.spyOn(sourcePdf, 'readSourcePdf').mockResolvedValue({ versionId: 'v1', sha256: report().sha256, data: 'JVBERi0=', size: 5, expires: clock() + 30000 });
  let now = clock();
  const reader = createStoredPgxReader(config, () => now);
  await reader(selection, clinician, binding);
  calls.length = 0;
  onRead = (_path, count) => {
    if (count === 10) now += 31000;
  };
  await expect(reader(selection, clinician, binding)).rejects.toThrow('stored_token_expired');
});

test('non-current selection returns history only without a fallback or source download', async () => {
  expect((await read()).bundle.resourceType).toBe('Bundle');
  evaluation().current = false;
  const result = await read();
  expect(result.bundle).toBeNull();
  expect(result.profile).toEqual([]);
  expect(result.history).toMatchObject({ evaluationId: uuid(3), state: 'active', current: false, events: [] });
});
const correction = (kind, n, previousCorrectionId = null) => ({
  id: uuid(n),
  evaluationId: uuid(3),
  kind,
  reasonCode: kind === 'reinstatement' ? 'retraction-mistaken' : 'input-misread',
  previousCorrectionId,
  replacementEvaluationId: kind === 'supersession' ? uuid(99) : null,
  note: { id: uuid(50), bodySha256: 'e'.repeat(64) },
  createdAt: time,
});
test('retraction, reinstatement and supersession history is bound to the selected evaluation', async () => {
  const initial = await read();
  evaluation().corrections = [correction('retraction', 10)];
  evaluation().state = 'retracted';
  evaluation().current = false;
  config.sourcePdf = { storageOrigin: 'http://127.0.0.1:5555' };
  const download = vi.spyOn(sourcePdf, 'readSourcePdf');
  const withdrawn = await read();
  expect(withdrawn.bundle).toBeNull();
  expect(withdrawn.profile).toEqual([]);
  expect(withdrawn.history.events).toEqual([{ id: uuid(10), kind: 'retraction', reasonCode: 'input-misread', createdAt: time }]);
  expect(download).not.toHaveBeenCalled();
  expect(JSON.stringify(withdrawn)).not.toContain('bodySha256');
  delete config.sourcePdf;
  evaluation().corrections.push(correction('reinstatement', 11, uuid(10)));
  evaluation().state = 'active';
  evaluation().current = true;
  const restored = await read();
  expect(validate(restored.bundle)).toBe(true);
  expect(restored.history.revision).not.toBe(initial.history.revision);
  expect(restored.bundle.entry.find((e) => e.resource.resourceType === 'DiagnosticReport').resource.extension).toContainEqual(
    expect.objectContaining({ valueString: restored.history.revision }),
  );
  evaluation().corrections.push(correction('supersession', 12, uuid(11)));
  evaluation().state = 'superseded';
  evaluation().current = false;
  evaluation().supersededBy = uuid(99);
  const superseded = await read();
  expect(superseded.bundle).toBeNull();
  expect(superseded.history.events).toHaveLength(3);
  expect(JSON.stringify(superseded)).not.toContain(uuid(99)); // no replacement traversal/identity export
});
test.each([
  [
    'cross-evaluation event',
    (e) => {
      e.evaluationId = uuid(100);
    },
  ],
  [
    'broken chain',
    (e) => {
      e.previousCorrectionId = uuid(100);
    },
  ],
  [
    'invalid reason',
    (e) => {
      e.reasonCode = 'retraction-mistaken';
    },
  ],
  [
    'invalid replacement',
    (e) => {
      e.replacementEvaluationId = uuid(100);
    },
  ],
])('withholds invalid history: %s', async (_name, mutate) => {
  evaluation().corrections = [correction('retraction', 10)];
  evaluation().state = 'retracted';
  evaluation().current = false;
  expect((await read()).history.state).toBe('retracted');
  mutate(evaluation().corrections[0]);
  await expect(read()).rejects.toThrow('invalid_correction_history');
});
