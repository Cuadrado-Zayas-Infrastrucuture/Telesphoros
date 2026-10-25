import express from 'express';
import http from 'node:http';
import request from 'supertest';
import { createPilotRouter } from '../src/router.js';
import { createSyntheticEhr } from './synthetic-ehr.js';

const pilotOrigin = 'http://127.0.0.1:8765';
let ehrServer;
let fixture;
let agent;
let clock;
async function setup(faults = {}, storedReader) {
  let handler;
  ehrServer = http.createServer((req, res) => handler(req, res));
  await new Promise((resolve) => ehrServer.listen(0, '127.0.0.1', resolve));
  fixture = createSyntheticEhr({
    origin: `http://127.0.0.1:${ehrServer.address().port}`,
    pilotOrigin,
    faults,
  });
  handler = fixture.app;
  const app = express();
  clock = Date.now();
  app.use(
    createPilotRouter({
      origin: pilotOrigin,
      registrations: { openemr: fixture.registration },
      now: () => clock,
      storedReader,
    }),
  );
  agent = request.agent(app);
}
const get = (path) => agent.get(path).set('Host', '127.0.0.1:8765');
async function begin(patient = 'patient-a') {
  const launch = await get(`/auth/fhir/pilot/launch/openemr?${new URLSearchParams({ iss: fixture.registration.issuer, launch: patient })}`);
  expect(launch.status).toBe(302);
  const authorization = await fetch(launch.headers.location, {
    redirect: 'manual',
  });
  expect(authorization.status).toBe(302);
  const callback = new URL(authorization.headers.get('location'));
  return callback.pathname + callback.search;
}
async function login(patient) {
  const callback = await begin(patient);
  const response = await get(callback);
  expect(response.status).toBe(302);
  return new URLSearchParams(response.headers.location.split('#')[1]).get('smart_session');
}
const evidence = (token) => get('/auth/fhir/pilot/evidence').set('Authorization', `Bearer ${token}`);
afterEach(async () => {
  if (ehrServer) {
    ehrServer.closeAllConnections();
    await new Promise((resolve) => ehrServer.close(resolve));
  }
});

test('real HTTP OAuth, PKCE, signed identity and two-page FHIR context; no EHR writes', async () => {
  await setup();
  const response = await evidence(await login());
  expect(response.status).toBe(200);
  expect(response.body.status).toBe('synthetic_context_ready');
  expect(response.body.pagesRead).toBe(2);
  expect(response.body.medications).toHaveLength(2);
  expect(response.body.clinician).toBe('Practitioner/clinician-a');
  expect(response.body.clinicalRecommendationsEnabled).toBe(false);
  expect(response.body.pgxFhirPreview.resourceType).toBe('Bundle');
  expect(JSON.stringify(response.body)).not.toMatch(/access_token|refresh_token|id_token/);
  expect(fixture.requests.filter((r) => r.method !== 'GET').map((r) => r.path)).toEqual(['/oauth/token']);
});
test('simultaneous launch sessions retain separate clinician and patient contexts', async () => {
  await setup();
  const [a, b] = await Promise.all([begin('patient-a'), begin('patient-b')]);
  const tokens = [];
  for (const callback of [a, b]) {
    const result = await get(callback);
    expect(result.status).toBe(302);
    tokens.push(new URLSearchParams(result.headers.location.split('#')[1]).get('smart_session'));
  }
  const [ra, rb] = await Promise.all(tokens.map(evidence));
  expect(ra.body.patient).toBe('patient-a');
  expect(rb.body.patient).toBe('patient-b');
  expect(ra.body.clinician).toBe('Practitioner/clinician-a');
  expect(rb.body.clinician).toBe('Practitioner/clinician-b');
});
test('callback replay and callback from another browser are rejected', async () => {
  await setup();
  const callback = await begin();
  const outsider = request(
    express().use(
      createPilotRouter({
        origin: pilotOrigin,
        registrations: { openemr: fixture.registration },
      }),
    ),
  );
  expect((await outsider.get(callback).set('Host', '127.0.0.1:8765')).status).toBe(400);
  expect((await get(callback)).status).toBe(302);
  expect((await get(callback)).status).toBe(400);
});
test.each(['nonce', 'audience', 'issuer', 'expired', 'signature', 'scope'])('rejects invalid OIDC/scope: %s', async (fault) => {
  await setup({
    [fault]: fault === 'scope' ? 'launch openid fhirUser patient/*.write' : true,
  });
  expect((await get(await begin())).status).toBe(400);
});
test.each([
  ['nonSynthetic', true],
  ['crossPatient', true],
  ['next', 'https://example.com/steal'],
  ['next', '/fhir/MedicationRequest?patient=another-patient'],
])('rejects unsafe clinical context: %s', async (fault, value) => {
  await setup({ [fault]: value });
  expect((await evidence(await login())).status).toBe(422);
});
test.each([
  ['patient-no-consent', 'consent_required'],
  ['patient-invalid', 'genotype_not_interpretable'],
  ['patient-no-profile', 'pgx_unavailable'],
  ['patient-empty', 'medications_unavailable'],
])('shows explicit unavailable state for %s', async (patient, status) => {
  await setup();
  const response = await evidence(await login(patient));
  expect(response.status).toBe(200);
  expect(response.body.status).toBe(status);
  expect(response.body.pgxFhirPreview).toBeNull();
  if (['consent_required', 'genotype_not_interpretable'].includes(status)) expect(response.body.profile).toHaveLength(0);
});
test.each(['unknownStatus', 'uncoded'])('does not interpret incomplete medications: %s', async (fault) => {
  await setup({ [fault]: true });
  const response = await evidence(await login());
  expect(['medications_incomplete', 'medications_unavailable']).toContain(response.body.status);
});
test('rejects caller tenant/scope overrides, foreign issuer, host rebinding and writes', async () => {
  await setup();
  const base = `/auth/fhir/pilot/launch/openemr?${new URLSearchParams({ iss: fixture.registration.issuer, launch: 'patient-a' })}`;
  for (const suffix of ['&tenant_id=other', '&scope=patient/*.write']) expect((await get(base + suffix)).status).toBe(400);
  expect((await get('/auth/fhir/pilot/launch/openemr?iss=https://foreign.example&launch=x')).status).toBe(400);
  expect((await agent.get(base).set('Host', 'foreign.example')).status).toBe(400);
  expect((await agent.post('/auth/fhir/pilot/evidence').set('Host', '127.0.0.1:8765')).status).toBe(405);
});
test('expires sessions and authorization state', async () => {
  await setup();
  const token = await login();
  const callback = await begin();
  clock += 16 * 60 * 1000;
  expect((await evidence(token)).status).toBe(401);
  expect((await get(callback)).status).toBe(400);
});

test('supports an explicitly identified signing key', async () => {
  await setup({ withKid: true });
  expect((await evidence(await login())).status).toBe(200);
});
test.each(['ambiguousKeys', 'person'])('rejects ambiguous keys or non-clinician identity: %s', async (fault) => {
  await setup({ [fault]: true });
  expect((await get(await begin())).status).toBe(400);
});
test('stops cyclic pagination without repeatedly fetching', async () => {
  await setup({ loop: true });
  expect((await evidence(await login())).status).toBe(422);
  expect(fixture.requests.filter((r) => r.path === '/fhir/MedicationRequest')).toHaveLength(1);
});
test('does not accept a known EHR patient without exact local mapping', async () => {
  await setup();
  fixture.registration.patients = fixture.registration.patients.filter((p) => p.fhirId !== 'patient-a');
  expect((await evidence(await login())).status).toBe(422);
});

test.each(['searchset', 'collection', 'transaction'])('accepts only supported medication bundle shapes: %s', async (bundleType) => {
  await setup({ bundleType });
  const response = await evidence(await login());
  expect(response.status).toBe(bundleType === 'transaction' ? 422 : 200);
});

test('follows query-relative next links against the current medication page', async () => {
  await setup({ next: '?patient=patient-a&page=2' });
  const response = await evidence(await login());
  expect(response.status).toBe(200);
  expect(response.body.pagesRead).toBe(2);
  expect(response.body.medications).toHaveLength(2);
});
test('withholds evidence if its session expires while upstream data is being read', async () => {
  await setup({
    onMedicationRead: () => {
      clock += 16 * 60 * 1000;
    },
  });
  const response = await evidence(await login());
  expect(response.status).toBe(401);
  expect(response.body).toEqual({ error: 'smart_session_expired' });
});
test.each([{ azp: 'another-client' }, { subject: 42 }])('rejects mismatched authorized party or malformed subject: %j', async (faults) => {
  await setup(faults);
  expect((await get(await begin())).status).toBe(400);
});
test('accepts an explicit authorized party matching this client', async () => {
  await setup({ azp: 'synthetic-client' });
  expect((await evidence(await login())).status).toBe(200);
});

// Same authenticated route and expiration boundary as medication context; no separate export bypass.
test.each(['retracted', 'held', 'missing', 'wrong-patient', 'stale-acceptance'])('HTTP withholds versioned FHIR on %s', async (fault) => {
  await setup();
  const token = await login();
  expect((await evidence(token)).body.pgxFhirPreview.resourceType).toBe('Bundle');
  const p = fixture.registration.patients[0];
  if (fault === 'missing') delete p.pgx;
  else {
    const v = p.pgx.versions[1];
    if (fault === 'retracted') v.state = 'retracted';
    if (fault === 'held') v.disposition = 'held';
    if (fault === 'wrong-patient') v.patientId = fixture.registration.patients[1].patientId;
    if (fault === 'stale-acceptance') v.acceptance.current = false;
  }
  const response = await evidence(token);
  expect(response.status).toBe(200);
  expect(response.body.pgxFhirPreview).toBeNull();
  expect(response.body.clinicalRecommendationsEnabled).toBe(false);
});

const storedSelection = { patientId: '00000000-0000-4000-8000-000000000001', label: 'SYN-STORED', evaluationId: '00000000-0000-4000-8000-000000000003' };
const storedOutput = () => ({
  bundle: { resourceType: 'Bundle', type: 'collection', entry: [] },
  expires: clock + 10000,
  profile: [{ gene: 'CYP2C19', result: 'Synthetic stored result' }],
});
test('stored mode uses the verified clinician binding and never returns the static profile', async () => {
  const read = vi.fn(async () => storedOutput());
  await setup({}, read);
  const p = fixture.registration.patients[0];
  p.stored = storedSelection;
  p.profile = [];
  const response = await evidence(await login());
  expect(response.status).toBe(200);
  expect(response.body.evidenceSource).toBe('stored-synthetic');
  expect(response.body.status).toBe('synthetic_context_ready');
  expect(response.body.profile).toEqual(storedOutput().profile);
  expect(Date.parse(response.body.expiresAt)).toBe(clock + 10000);
  expect(read.mock.calls[0][1]).toBe('Practitioner/clinician-a');
  expect(read.mock.calls[0][2].fhirPatient).toBe('patient-a');
});
test('stored mode without credentials is unavailable, with no fixture fallback', async () => {
  await setup();
  fixture.registration.patients[0].stored = storedSelection;
  const response = await evidence(await login());
  expect(response.body.status).toBe('pgx_unavailable');
  expect(response.body.pgxFhirPreview).toBeNull();
  expect(response.body.profile).toEqual([]);
});
test.each(['patient-no-consent', 'patient-invalid', 'patient-empty'])('stored reader is not called behind gate %s', async (patient) => {
  const read = vi.fn(async () => storedOutput());
  await setup({}, read);
  fixture.registration.patients.find((p) => p.fhirId === patient).stored = storedSelection;
  const response = await evidence(await login(patient));
  expect(response.status).toBe(200);
  expect(response.body.pgxFhirPreview).toBeNull();
  expect(read).not.toHaveBeenCalled();
});
test('late SMART expiry after stored reads withholds everything', async () => {
  const read = vi.fn(async () => {
    clock += 360000;
    return storedOutput();
  });
  await setup({}, read);
  fixture.registration.patients[0].stored = storedSelection;
  const response = await evidence(await login());
  expect(response.status).toBe(401);
  expect(response.body.pgxFhirPreview).toBeUndefined();
});
test('stored read errors expose neither credentials nor partial data', async () => {
  const read = vi.fn(async () => {
    throw new Error('sensitive-credential-sentinel');
  });
  await setup({}, read);
  fixture.registration.patients[0].stored = storedSelection;
  const response = await evidence(await login());
  expect(response.status).toBe(422);
  expect(response.body.pgxFhirPreview).toBeUndefined();
  expect(JSON.stringify(response.body)).not.toContain('sensitive-credential-sentinel');
});
test('history-only stored response never exports a genomic profile or PDF', async () => {
  const history = { evaluationId: storedSelection.evaluationId, state: 'retracted', current: false, events: [], revision: 'a'.repeat(64) };
  await setup({}, async () => ({ bundle: null, profile: [], expires: clock + 60000, history }));
  fixture.registration.patients[0].stored = storedSelection;
  const response = await evidence(await login());
  expect(response.status).toBe(200);
  expect(response.body.status).toBe('evaluation_withheld');
  expect(response.body.correctionHistory).toEqual(history);
  expect(response.body.pgxFhirPreview).toBeNull();
  expect(response.body.profile).toEqual([]);
  expect(Date.parse(response.body.freshUntil)).toBe(clock + 30000);
});
test('a slow read cannot issue already-stale evidence', async () => {
  let slow = false;
  await setup({}, async () => {
    if (slow) clock += 31000;
    return { ...storedOutput(), expires: clock + 60000 };
  });
  fixture.registration.patients[0].stored = storedSelection;
  const token = await login();
  expect((await evidence(token)).status).toBe(200);
  slow = true;
  const response = await evidence(token);
  expect(response.status).toBe(422);
  expect(response.body.pgxFhirPreview).toBeUndefined();
});
