import { randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { duplicateCandidateDtoSchema, patientMergeDtoSchema } from '@telesphoros/shared-types';
import request from 'supertest';
import { createTestApp, usingPostgres } from './helpers/app';
import { createEphemeralDatabase, type EphemeralDatabase, withAdmin } from './helpers/database';
import { fixturePdf, LabPipeline, type Person } from './helpers/lab-pipeline';
import { bearer, signToken } from './helpers/tokens';

/**
 * Possible duplicates and the merge of two patient records (M2.1c-2). The duplicate flags run in memory and on PostgreSQL; a merge is a ledger
 * record and exists only on PostgreSQL (in memory, merging answers 503). Synthetic data only.
 */
let app: NestExpressApplication;
let db: EphemeralDatabase | undefined;
const api = () => request(app.getHttpServer());
const tenantOf = () => `org-${randomUUID().slice(0, 8)}`;
const as = async (tenant: string, roles: string[], sub = `person-${randomUUID().slice(0, 6)}`) => bearer(await signToken({ sub, roles, tenant }));
const newPatient = async (headers: Record<string, string>, label = `SYN-${randomUUID().slice(0, 8)}`) => (await api().post('/api/v1/patients').set(headers).send({ label }).expect(201)).body.id as string;
const register = (headers: Record<string, string>, patientId: string, system: string, value: string) => api().post(`/api/v1/patients/${patientId}/identifiers`).set(headers).send({ system, value });
const secretNumber = () => `ZQX-${randomUUID().replace(/-/g, '').slice(0, 12).toUpperCase()}`;
const duplicates = (headers: Record<string, string>) => api().get('/api/v1/patient-duplicates').set(headers);

beforeAll(async () => {
  if (usingPostgres()) {
    db = await createEphemeralDatabase();
    app = await createTestApp({ labReportPipeline: true, postgresUrl: db.appUrl, ownerUrl: db.adminUrl });
  } else {
    app = await createTestApp();
  }
}, 60_000);
afterAll(async () => {
  await app.close();
  await db?.drop();
});

describe('possible duplicates', () => {
  it('leaves a flag when an identifier collides with another patient, keeps answering 409, and shows the pair without any number', async () => {
    const tenant = tenantOf();
    const clin = await as(tenant, ['clinician']);
    const [first, second] = [await newPatient(clin, 'SYN-FIRST'), await newPatient(clin, 'SYN-SECOND')];
    const value = secretNumber();
    await register(clin, first, 'hospital-a-mrn', value).expect(201);
    expect((await duplicates(clin).expect(200)).body.data).toEqual([]); // no collision yet
    const refused = await register(clin, second, 'hospital-a-mrn', value).expect(409);
    expect(refused.body.error.details?.[0]?.reason).toBe('identifier-in-use');
    expect((await api().get(`/api/v1/patients/${second}/identifiers`).set(clin).expect(200)).body.data).toEqual([]); // nothing was stored for the second patient

    const listed = (await duplicates(clin).expect(200)).body;
    expect(listed.data).toHaveLength(1);
    expect(duplicateCandidateDtoSchema.safeParse(listed.data[0]).success).toBe(true);
    expect([listed.data[0].patientLabel, listed.data[0].otherPatientLabel].sort()).toEqual(['SYN-FIRST', 'SYN-SECOND']);
    expect([listed.data[0].patientId, listed.data[0].otherPatientId].sort()).toEqual([first, second].sort());
    expect(listed.data[0].system).toBe('hospital-a-mrn');
    expect(listed.meta).toMatchObject({ total: 1 });
    expect(JSON.stringify(listed).toLowerCase()).not.toMatch(/digest|hmac|"value"/);
    expect(JSON.stringify(listed)).not.toContain(value);
  });

  it('keeps one flag per pair however often and whichever way round it collides, and none for a number a patient registers twice', async () => {
    const tenant = tenantOf();
    const clin = await as(tenant, ['clinician']);
    const [a, b] = [await newPatient(clin), await newPatient(clin)];
    const value = secretNumber();
    await register(clin, a, 'hospital-a-mrn', value).expect(201);
    await register(clin, b, 'hospital-a-mrn', value).expect(409);
    await register(clin, b, 'hospital-a-mrn', value).expect(409);
    await register(clin, a, 'hospital-a-mrn', value).expect(409); // the same patient again: a refusal, but not a duplicate
    expect((await duplicates(clin).expect(200)).body.data).toHaveLength(1);
    const solo = await newPatient(clin);
    const own = secretNumber();
    await register(clin, solo, 'hospital-a-mrn', own).expect(201);
    await register(clin, solo, 'hospital-a-mrn', own).expect(409);
    expect((await duplicates(clin).expect(200)).body.meta.total).toBe(1); // still only the one pair
  });

  it('keeps organizations apart and lets only people who may read clinical records see the list', async () => {
    const tenant = tenantOf();
    const clin = await as(tenant, ['clinician']);
    const [a, b] = [await newPatient(clin), await newPatient(clin)];
    const value = secretNumber();
    await register(clin, a, 'hospital-a-mrn', value).expect(201);
    await register(clin, b, 'hospital-a-mrn', value).expect(409);
    expect((await duplicates(await as(tenantOf(), ['clinician'])).expect(200)).body.data).toEqual([]);
    // The same number in another organization is not a collision at all.
    const elsewhere = await as(tenantOf(), ['clinician']);
    await register(elsewhere, await newPatient(elsewhere), 'hospital-a-mrn', value).expect(201);
    expect((await duplicates(await as(tenant, ['reader'])).expect(200)).body.data).toHaveLength(1);
    expect((await duplicates(await as(tenant, ['reviewer'])).expect(200)).body.data).toHaveLength(1);
    await duplicates(await as(tenant, ['admin'])).expect(403); // administration alone reads no clinical data
    await duplicates(await as(tenant, [])).expect(403);
    await api().get('/api/v1/patient-duplicates').expect(401);
  });

  it('pages the list, newest first', async () => {
    const tenant = tenantOf();
    const clin = await as(tenant, ['clinician']);
    const hub = await newPatient(clin, 'SYN-HUB');
    const value = secretNumber();
    await register(clin, hub, 'hospital-a-mrn', value).expect(201);
    for (const label of ['SYN-ONE', 'SYN-TWO', 'SYN-THREE']) await register(clin, await newPatient(clin, label), 'hospital-a-mrn', value).expect(409);
    const first = (await api().get('/api/v1/patient-duplicates?page=1&pageSize=2').set(clin).expect(200)).body;
    const second = (await api().get('/api/v1/patient-duplicates?page=2&pageSize=2').set(clin).expect(200)).body;
    expect(first.meta).toMatchObject({ total: 3, totalPages: 2 });
    const labels = [...first.data, ...second.data].map((d: Record<string, string>) => [d.patientLabel, d.otherPatientLabel].find((l) => l !== 'SYN-HUB'));
    expect(labels).toEqual(['SYN-THREE', 'SYN-TWO', 'SYN-ONE']);
  });
});

describe('who may propose and decide a merge', () => {
  it('refuses an administrator alone, a reader, a person with no role and no token, on every merge route', async () => {
    const tenant = tenantOf();
    const clin = await as(tenant, ['clinician']);
    const [a, b] = [await newPatient(clin), await newPatient(clin)];
    const body = { kind: 'merge', sourcePatientId: a, targetPatientId: b, reasonCode: 'entered-twice' };
    for (const roles of [['admin'], ['reader'], []]) {
      const headers = await as(tenant, roles);
      await api().post('/api/v1/patient-merges').set(headers).send(body).expect(403);
      await api().post(`/api/v1/patient-merges/${randomUUID()}/decision`).set(headers).send({ decision: 'approved' }).expect(403);
    }
    for (const roles of [['admin'], []]) {
      const headers = await as(tenant, roles);
      await api().get('/api/v1/patient-merges').set(headers).expect(403);
      await api().get(`/api/v1/patient-merges/${randomUUID()}`).set(headers).expect(403);
    }
    await api().post('/api/v1/patient-merges').send(body).expect(401);
  });

  it('validates what is proposed: the reason must go with the kind, a patient cannot be merged into itself, nothing extra is accepted', async () => {
    const tenant = tenantOf();
    const clin = await as(tenant, ['clinician']);
    const [a, b] = [await newPatient(clin), await newPatient(clin)];
    for (const bad of [
      { kind: 'merge', sourcePatientId: a, targetPatientId: b, reasonCode: 'merged-by-mistake' },
      { kind: 'unmerge', sourcePatientId: a, targetPatientId: b, reasonCode: 'entered-twice' },
      { kind: 'merge', sourcePatientId: a, targetPatientId: a, reasonCode: 'entered-twice' },
      { kind: 'merge', sourcePatientId: a, targetPatientId: b, reasonCode: 'because' },
      { kind: 'merge', sourcePatientId: 'not-a-uuid', targetPatientId: b, reasonCode: 'entered-twice' },
      { kind: 'merge', sourcePatientId: a, targetPatientId: b, reasonCode: 'entered-twice', note: 'free text' },
      { kind: 'merge', sourcePatientId: a, reasonCode: 'entered-twice' },
    ]) {
      await api().post('/api/v1/patient-merges').set(clin).send(bad).expect(400);
    }
    await api().post(`/api/v1/patient-merges/${randomUUID()}/decision`).set(clin).send({ decision: 'maybe' }).expect(400);
  });
});

(usingPostgres() ? describe : describe.skip)('merging two patient records', () => {
  let lab: LabPipeline;
  const merges = (who: Person, query = '') => lab.api().get(`/api/v1/patient-merges${query}`).set(bearer(who.token));
  const propose = (who: Person, kind: 'merge' | 'unmerge', source: string, target: string, reasonCode = kind === 'merge' ? 'entered-twice' : 'merged-by-mistake') =>
    lab.api().post('/api/v1/patient-merges').set(bearer(who.token)).send({ kind, sourcePatientId: source, targetPatientId: target, reasonCode });
  const decide = (who: Person, id: string, decision: 'approved' | 'declined') => lab.api().post(`/api/v1/patient-merges/${id}/decision`).set(bearer(who.token)).send({ decision });
  const patients = (who: Person, query = '') => lab.api().get(`/api/v1/patients${query}`).set(bearer(who.token));

  /** A fresh organization with two clinicians (so one proposes and the other decides) and a reviewer. */
  async function organization() {
    lab = new LabPipeline(app, db!.adminUrl, tenantOf());
    const [c1, c2, reviewer] = [await lab.person('clin-one', ['clinician']), await lab.person('clin-two', ['clinician']), await lab.person('rev', ['reviewer'])];
    return { c1, c2, reviewer };
  }

  it('proposes, is decided by someone else, and changes how the pair reads without rewriting either patient', async () => {
    const { c1, c2 } = await organization();
    const [a, b] = [await lab.patient(c1), await lab.patient(c1)];
    const before = (await patients(c1, '?includeMerged=true').expect(200)).body.data;

    const proposed = await propose(c1, 'merge', a, b).expect(201);
    expect(patientMergeDtoSchema.safeParse(proposed.body).success).toBe(true);
    expect(proposed.body).toMatchObject({ kind: 'merge', sourcePatientId: a, targetPatientId: b, reasonCode: 'entered-twice', status: 'pending', decidedAt: null });
    // Nothing changes until it is decided.
    expect((await patients(c1).expect(200)).body.data.map((p: { id: string }) => p.id)).toEqual(expect.arrayContaining([a, b]));

    const self = await decide(c1, proposed.body.id, 'approved').expect(409);
    expect(self.body.error.details[0].reason).toBe('self-review');
    const approved = await decide(c2, proposed.body.id, 'approved').expect(201);
    expect(approved.body).toMatchObject({ id: proposed.body.id, status: 'approved', decidedAt: expect.any(String) });
    await decide(c2, proposed.body.id, 'approved').expect(200); // the same decision again
    const changed = await decide(c2, proposed.body.id, 'declined').expect(409);
    expect(changed.body.error.details[0].reason).toBe('merge-already-decided');

    // The pair now reads as one: the merged-away patient is hidden by default and says where it went.
    const listed = (await patients(c1).expect(200)).body.data as { id: string; mergedInto: string | null }[];
    expect(listed.map((p) => p.id)).toContain(b);
    expect(listed.map((p) => p.id)).not.toContain(a);
    const all = (await patients(c1, '?includeMerged=true').expect(200)).body.data as { id: string; mergedInto: string | null }[];
    expect(all.find((p) => p.id === a)).toMatchObject({ mergedInto: b });
    expect(all.find((p) => p.id === b)).toMatchObject({ mergedInto: null });
    expect((await lab.api().get(`/api/v1/patients/${a}`).set(bearer(c1.token)).expect(200)).body.mergedInto).toBe(b);
    // No stored value of either patient moved.
    const strip = (rows: Record<string, unknown>[]) => rows.map(({ mergedInto: _m, ...rest }) => rest); // eslint-disable-line @typescript-eslint/no-unused-vars
    expect(strip(all)).toEqual(strip(before));
    expect(await lab.row(`SELECT count(*)::int AS n FROM patients WHERE tenant_id = $1`, [lab.tenant])).toEqual([{ n: 2 }]);
  });

  it('refuses new reports and identifiers on the merged-away patient, naming where they belong, and takes them on the other one', async () => {
    const { c1, c2 } = await organization();
    const [a, b] = [await lab.patient(c1), await lab.patient(c1)];
    const p = await propose(c1, 'merge', a, b).expect(201);
    await decide(c2, p.body.id, 'approved').expect(201);
    const report = await lab.api().post('/api/v1/reports').set(bearer(c1.token)).send({ patientId: a, type: 'vcf', filename: 'x.vcf', sizeBytes: 10 }).expect(409);
    expect(report.body.error.details[0]).toMatchObject({ reason: 'patient-merged' });
    expect(report.body.error.message).toContain(b);
    const ident = await lab.api().post(`/api/v1/patients/${a}/identifiers`).set(bearer(c1.token)).send({ system: 'hospital-a-mrn', value: secretNumber() }).expect(409);
    expect(ident.body.error.details[0]).toMatchObject({ reason: 'patient-merged' });
    await lab.api().post('/api/v1/reports').set(bearer(c1.token)).send({ patientId: b, type: 'vcf', filename: 'x.vcf', sizeBytes: 10 }).expect(201);
    await lab.api().post(`/api/v1/patients/${b}/identifiers`).set(bearer(c1.token)).send({ system: 'hospital-a-mrn', value: secretNumber() }).expect(201);
  });

  it('makes a patient filter mean the whole group on reports, and an unmerge restores them exactly', async () => {
    const { c1, c2 } = await organization();
    const [a, b] = [await lab.patient(c1), await lab.patient(c1)];
    const make = async (patientId: string) => (await lab.api().post('/api/v1/reports').set(bearer(c1.token)).send({ patientId, type: 'vcf', filename: 'x.vcf', sizeBytes: 10 }).expect(201)).body.id as string;
    const [ra, rb] = [await make(a), await make(b)];
    const reportsOf = async (patientId: string) => ((await lab.api().get(`/api/v1/reports?patientId=${patientId}`).set(bearer(c1.token)).expect(200)).body.data as { id: string; patientId: string }[]).map((r) => r.id).sort();
    expect(await reportsOf(a)).toEqual([ra]);
    expect(await reportsOf(b)).toEqual([rb]);

    const m = await propose(c1, 'merge', a, b).expect(201);
    await decide(c2, m.body.id, 'approved').expect(201);
    expect(await reportsOf(a)).toEqual([ra, rb].sort());
    expect(await reportsOf(b)).toEqual([ra, rb].sort());
    // Each report still names the patient it was written for.
    const rows = (await lab.api().get(`/api/v1/reports?patientId=${b}`).set(bearer(c1.token)).expect(200)).body.data as { id: string; patientId: string }[];
    expect(Object.fromEntries(rows.map((r) => [r.id, r.patientId]))).toEqual({ [ra]: a, [rb]: b });

    const un = await propose(c2, 'unmerge', a, b).expect(201);
    await decide(c1, un.body.id, 'approved').expect(201);
    expect(await reportsOf(a)).toEqual([ra]);
    expect(await reportsOf(b)).toEqual([rb]);
    expect((await patients(c1).expect(200)).body.data.map((p: { id: string }) => p.id)).toEqual(expect.arrayContaining([a, b]));
  });

  it('lets an identifier registered on any patient of the group verify a report of another, and not before they are one', async () => {
    const { c1, c2, reviewer } = await organization();
    const [a, b] = [await lab.patient(c1), await lab.patient(c1)];
    const number = secretNumber();
    await lab.api().post(`/api/v1/patients/${b}/identifiers`).set(bearer(c1.token)).send({ system: 'hospital-a-mrn', value: number }).expect(201);
    // A report on patient `a`, uploaded and captured by a clinician; the reviewer will decide whose it is.
    const up = await lab.uploadedLabPdf(c1, fixturePdf('D01'), { patientId: a });
    const match = { decision: 'verified', method: 'identifier-match', system: 'hospital-a-mrn', value: number };

    const before = await lab.decideLink(reviewer, up.reportId, match).expect(409);
    expect(before.body.error.details[0].reason).toBe('identifier-mismatch'); // `a` does not hold that number, and is not yet one with `b`
    const m = await propose(c1, 'merge', a, b).expect(201);
    await decide(c2, m.body.id, 'approved').expect(201);
    const after = await lab.decideLink(reviewer, up.reportId, match).expect(201);
    expect(after.body).toMatchObject({ decision: 'verified', method: 'identifier-match' });
    expect(JSON.stringify(after.body)).not.toContain(number);
  });

  it('makes an evaluation filter by patient mean the whole group too', async () => {
    const { c1, c2, reviewer } = await organization();
    const [a, b] = [await lab.patient(c1), await lab.patient(c1)];
    const up = await lab.uploadedLabPdf(c1, fixturePdf('D01'), { patientId: a });
    const capture = (await lab.capture(c1, up.reportId).expect(201)).body;
    const acceptance = (await lab.decide(reviewer, capture.id, { decision: 'accepted' }).expect(201)).body;
    await lab.verifyLink(reviewer, up.reportId).expect(201);
    const evaluation = (await lab.evaluate(c1, up.reportId, { captureId: capture.id, acceptanceId: acceptance.id }).expect(201)).body;
    const ids = async (patientId: string) => ((await lab.api().get(`/api/v1/evaluations?patientId=${patientId}`).set(bearer(c1.token)).expect(200)).body.data as { id: string }[]).map((e) => e.id);
    // The whole stored record of the evaluation and of its report, byte for byte, before and after a merge and its unmerge.
    const snapshot = async () => JSON.stringify([
      (await lab.api().get(`/api/v1/evaluations/${evaluation.id}`).set(bearer(c1.token)).expect(200)).body,
      (await lab.api().get(`/api/v1/reports/${up.reportId}`).set(bearer(c1.token)).expect(200)).body,
    ]);
    const before = await snapshot();
    expect(await ids(a)).toEqual([evaluation.id]);
    expect(await ids(b)).toEqual([]);
    const m = await propose(c1, 'merge', a, b).expect(201);
    await decide(c2, m.body.id, 'approved').expect(201);
    expect(await ids(b)).toEqual([evaluation.id]); // found from the other patient of the group
    expect(await ids(a)).toEqual([evaluation.id]);
    // The evaluation itself still names the patient it was made for, and is still current.
    expect((await lab.api().get(`/api/v1/evaluations/${evaluation.id}`).set(bearer(c1.token)).expect(200)).body).toMatchObject({ patientId: a, current: true });
    expect(await snapshot()).toBe(before); // a merge rewrites neither the evaluation nor the report
    const un = await propose(c2, 'unmerge', a, b).expect(201);
    await decide(c1, un.body.id, 'approved').expect(201);
    expect(await ids(b)).toEqual([]);
    expect(await snapshot()).toBe(before);
  });

  it('removes a reviewed pair from the review list, and a declined proposal dismisses the pair for good', async () => {
    const { c1, c2 } = await organization();
    const [a, b, c, d] = [await lab.patient(c1), await lab.patient(c1), await lab.patient(c1), await lab.patient(c1)];
    const collide = async (x: string, y: string) => {
      const value = secretNumber();
      await lab.api().post(`/api/v1/patients/${x}/identifiers`).set(bearer(c1.token)).send({ system: 'hospital-a-mrn', value }).expect(201);
      await lab.api().post(`/api/v1/patients/${y}/identifiers`).set(bearer(c1.token)).send({ system: 'hospital-a-mrn', value }).expect(409);
      return value;
    };
    const listed = async () => ((await lab.api().get('/api/v1/patient-duplicates').set(bearer(c1.token)).expect(200)).body.data as { patientId: string; otherPatientId: string }[]).map((p) => [p.patientId, p.otherPatientId].sort().join('|'));
    const key = (x: string, y: string) => [x, y].sort().join('|');
    await collide(a, b);
    await collide(c, d);
    expect((await listed()).sort()).toEqual([key(a, b), key(c, d)].sort());

    const merge = await propose(c1, 'merge', a, b, 'shared-identifier').expect(201);
    await decide(c2, merge.body.id, 'approved').expect(201);
    expect(await listed()).toEqual([key(c, d)]); // already one group

    const refuse = await propose(c1, 'merge', c, d, 'shared-identifier').expect(201);
    await decide(c2, refuse.body.id, 'declined').expect(201);
    expect(await listed()).toEqual([]); // dismissed
    await lab.api().post(`/api/v1/patients/${d}/identifiers`).set(bearer(c1.token)).send({ system: 'another-system', value: 'whatever' }).expect(201);
    const again = secretNumber();
    await lab.api().post(`/api/v1/patients/${c}/identifiers`).set(bearer(c1.token)).send({ system: 'hospital-b-mrn', value: again }).expect(201);
    await lab.api().post(`/api/v1/patients/${d}/identifiers`).set(bearer(c1.token)).send({ system: 'hospital-b-mrn', value: again }).expect(409); // collides again
    expect(await listed()).toEqual([]); // the declined pair does not come back
  });

  it('refuses a merge the patients cannot take, with a reason the person can act on', async () => {
    const { c1, c2 } = await organization();
    const [a, b, c] = [await lab.patient(c1), await lab.patient(c1), await lab.patient(c1)];
    const m = await propose(c1, 'merge', a, b).expect(201);
    await decide(c2, m.body.id, 'approved').expect(201);
    const reason = async (res: request.Test) => (await res).body.error.details[0].reason as string;
    expect(await reason(propose(c1, 'merge', a, c).expect(409))).toBe('merge-source-merged');
    expect(await reason(propose(c1, 'merge', c, a).expect(409))).toBe('merge-target-merged');
    expect(await reason(propose(c1, 'merge', b, c).expect(409))).toBe('merge-source-has-aliases');
    expect(await reason(propose(c1, 'unmerge', c, b).expect(409))).toBe('merge-not-merged');
    const pending = await propose(c1, 'merge', c, b).expect(201);
    expect(await reason(propose(c2, 'merge', c, b).expect(409))).toBe('merge-proposal-pending');
    expect(pending.body.status).toBe('pending');
  });

  it('checks again when it is decided, so two proposals that were each possible cannot both be approved', async () => {
    const { c1, c2 } = await organization();
    const [a, b, c] = [await lab.patient(c1), await lab.patient(c1), await lab.patient(c1)];
    const one = await propose(c1, 'merge', a, b).expect(201);
    const two = await propose(c1, 'merge', a, c).expect(201);
    await decide(c2, one.body.id, 'approved').expect(201);
    const lost = await decide(c2, two.body.id, 'approved').expect(409);
    expect(lost.body.error.details[0].reason).toBe('merge-source-merged');
    expect((await merges(c1, '?status=pending').expect(200)).body.data.map((m: { id: string }) => m.id)).toEqual([two.body.id]); // still undecided
    await decide(c2, two.body.id, 'declined').expect(201);
  });

  it('lists and reads the history newest first, filtered by state, and keeps organizations apart', async () => {
    const { c1, c2 } = await organization();
    const [a, b, c, d] = [await lab.patient(c1), await lab.patient(c1), await lab.patient(c1), await lab.patient(c1)];
    const first = await propose(c1, 'merge', a, b).expect(201);
    await decide(c2, first.body.id, 'approved').expect(201);
    const second = await propose(c1, 'merge', c, d).expect(201);
    const all = (await merges(c1).expect(200)).body;
    expect(all.data.map((m: { id: string }) => m.id)).toEqual([second.body.id, first.body.id]);
    expect(all.meta).toMatchObject({ total: 2 });
    expect((await merges(c1, '?status=approved').expect(200)).body.data.map((m: { id: string }) => m.id)).toEqual([first.body.id]);
    expect((await merges(c1, '?status=declined').expect(200)).body.data).toEqual([]);
    expect((await lab.api().get(`/api/v1/patient-merges/${first.body.id}`).set(bearer(c1.token)).expect(200)).body).toMatchObject({ id: first.body.id, status: 'approved' });
    await lab.api().get(`/api/v1/patient-merges/${randomUUID()}`).set(bearer(c1.token)).expect(404);

    const stranger = await lab.person('stranger', ['clinician'], tenantOf());
    await lab.api().get(`/api/v1/patient-merges/${first.body.id}`).set(bearer(stranger.token)).expect(404);
    expect((await merges(stranger).expect(200)).body.data).toEqual([]);
    await lab.api().post(`/api/v1/patient-merges/${second.body.id}/decision`).set(bearer(stranger.token)).send({ decision: 'approved' }).expect(404);
    await propose(stranger, 'merge', a, b).expect(404); // another organization's patients do not exist here
    // No person is named in anything a response carries.
    expect(JSON.stringify(all)).not.toContain(c1.sub);
    expect(JSON.stringify(all)).not.toContain(c2.sub);
  });
});

(usingPostgres() ? describe : describe.skip)('on PostgreSQL: a collision keeps no number and no digest outside the identifier table', () => {
  it('leaves exactly one flag, and neither the number nor its stored digest is in any other table', async () => {
    const tenant = tenantOf();
    const clin = await as(tenant, ['clinician']);
    const [a, b] = [await newPatient(clin), await newPatient(clin)];
    const value = secretNumber();
    await register(clin, a, 'hospital-a-mrn', value).expect(201);
    await register(clin, b, 'hospital-a-mrn', value).expect(409);
    await register(clin, b, 'hospital-a-mrn', value).expect(409);
    await withAdmin(db!.adminUrl, async (c) => {
      expect((await c.query(`SELECT count(*)::int AS n FROM patient_duplicate_flags WHERE tenant_id = $1`, [tenant])).rows[0].n).toBe(1);
      const digest = (await c.query(`SELECT encode(value_digest, 'hex') AS hex FROM patient_identifiers WHERE tenant_id = $1`, [tenant])).rows[0].hex as string;
      expect(digest).toHaveLength(64);
      const tables = (await c.query(`SELECT tablename FROM pg_tables WHERE schemaname = 'public'`)).rows.map((r) => r.tablename as string);
      const hits: string[] = [];
      for (const table of tables) {
        for (const [what, needle] of [['number', value], ['digest', digest]] as const) {
          // bytea renders as \x<hex> in the row text; a digest could therefore only show up as its hex.
          const { rows } = await c.query(`SELECT count(*)::int AS n FROM "${table}" t WHERE t::text ILIKE $1`, [`%${needle}%`]);
          if (rows[0].n > 0 && !(table === 'patient_identifiers' && what === 'digest')) hits.push(`${table}: ${what}`);
        }
      }
      expect(hits).toEqual([]); // the only place the digest lives is the identifier table, and the number lives nowhere
      // Control: the scan does see a digest where one is stored.
      expect((await c.query(`SELECT count(*)::int AS n FROM patient_identifiers t WHERE t::text ILIKE $1`, [`%${digest}%`])).rows[0].n).toBe(1);
    });
  });
});

(usingPostgres() ? describe.skip : describe)('without the PostgreSQL record store', () => {
  it('answers 503 for a merge (the ledger exists only on PostgreSQL) while the duplicate list still works', async () => {
    const tenant = tenantOf();
    const clin = await as(tenant, ['clinician']);
    const [a, b] = [await newPatient(clin), await newPatient(clin)];
    const res = await api().post('/api/v1/patient-merges').set(clin).send({ kind: 'merge', sourcePatientId: a, targetPatientId: b, reasonCode: 'entered-twice' }).expect(503);
    expect(res.body.error.code).toBe('SERVICE_UNAVAILABLE');
    await api().get('/api/v1/patient-merges').set(clin).expect(503);
    await duplicates(clin).expect(200);
    // Without merges every patient reads as itself.
    const listed = (await api().get('/api/v1/patients').set(clin).expect(200)).body.data as { mergedInto: unknown }[];
    expect(listed.every((p) => p.mergedInto === null)).toBe(true);
  });
});
