import { randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { RENDER_BATCH_MAX, resultRenderBatchResultSchema } from '@telesphoros/shared-types';
import { createTestApp, usingPostgres } from './helpers/app';
import { createEphemeralDatabase, type EphemeralDatabase } from './helpers/database';
import { fixturePdf, LabPipeline, type Person } from './helpers/lab-pipeline';
import { bearer } from './helpers/tokens';

// Spec 019, slice D02b: render capture over HTTP (T104). Every expected value is written by hand; the oracle for what was stored is the database, read
// through the administrator connection, never the code under test. Synthetic fixture D01 with the stand-in reader. The browser side is R3's Playwright.
(usingPostgres() ? describe : describe.skip)('result renders', () => {
  let db: EphemeralDatabase;
  let app: NestExpressApplication;
  let lab: LabPipeline;
  beforeAll(async () => {
    db = await createEphemeralDatabase();
    app = await createTestApp({ labReportPipeline: true, postgresUrl: db.appUrl });
  }, 60_000);
  // Render events and evaluations are tenant state: every test gets its own tenant.
  beforeEach(() => {
    lab = new LabPipeline(app, db.adminUrl);
  });
  afterAll(async () => {
    await app.close();
    await db.drop();
  });

  type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

  const post = (who: Person, body: object, on: LabPipeline = lab) => on.api().post('/api/v1/result-renders').set(bearer(who.token)).send(body);
  const stored = (where = 'true', values: unknown[] = []) => lab.count('result_render_events', `tenant_id = $1 AND ${where}`, [lab.tenant, ...values]);

  /** One report, one evaluation of D01; `result` is the first shown result. */
  async function evaluated(on: LabPipeline = lab, people?: { clinician: Person; reviewer: Person }) {
    const s = await on.reviewedCapture(fixturePdf('D01'), people);
    const e: Json = (await on.evaluate(s.clinician, s.reportId, { captureId: s.captureId, acceptanceId: s.acceptanceId }).expect(201)).body;
    const result: Json = e.results.find((r: Json) => r.outcome === 'shown');
    expect(result).toBeDefined(); // control: D01 shows a result
    return { ...s, e, result };
  }
  type Setup = Awaited<ReturnType<typeof evaluated>>;
  const SENT = '2026-10-29T15:04:10.000Z';
  const exposure = (resultId: string, extra: object = {}) => ({
    episodeId: randomUUID(),
    seq: 0,
    kind: 'exposure',
    resultId,
    measurement: 'viewport',
    ruleVersion: 'render-v1',
    schemaVersion: 1,
    capability: ['intersection-observer', 'page-visibility', 'focus-events'],
    occurredAt: '2026-10-29T15:04:05.000Z',
    continuousMs: 1000,
    cumulativeMs: 1000,
    ...extra,
  });
  const duration = (of: Json, seq: number, ms: number) => ({ ...of, seq, kind: 'duration', occurredAt: '2026-10-29T15:04:08.000Z', continuousMs: ms, cumulativeMs: ms });
  const batch = (...events: object[]) => ({ sentAt: SENT, events });

  describe('binding and tenancy (FR-02)', () => {
    it('stores a reader’s exposure (the control) against the result, its evaluation and patient, with the server’s receipt time', async () => {
      const s = await evaluated();
      const reader = await lab.person('r', ['reader']);
      const res = await post(reader, batch(exposure(s.result.id))).expect(200);
      expect(resultRenderBatchResultSchema.parse(res.body)).toEqual({ stored: 1, alreadyStored: 0, withoutExposure: 0 });
      const [row] = await lab.row<Json>(
        `SELECT viewer, viewer_roles, result_id::text, evaluation_id::text, patient_id::text, kind, seq, measurement, rule_version, continuous_ms,
                received_at > now() - interval '1 minute' AS fresh FROM result_render_events WHERE tenant_id = $1`,
        [lab.tenant],
      );
      expect(row).toEqual({
        viewer: reader.sub,
        viewer_roles: ['reader'],
        result_id: s.result.id,
        evaluation_id: s.e.id,
        patient_id: s.patientId,
        kind: 'exposure',
        seq: 0,
        measurement: 'viewport',
        rule_version: 'render-v1',
        continuous_ms: 1000,
        fresh: true,
      });
    });

    it("another tenant's reader gets 404, and a batch mixing an own result with a foreign or unknown one is 404 and stores none of it", async () => {
      const s = await evaluated();
      const outsider = await lab.person('x', ['reader'], `${lab.tenant}-other`);
      await post(outsider, batch(exposure(s.result.id))).expect(404);
      const reader = await lab.person('r', ['reader']);
      const otherLab = new LabPipeline(app, db.adminUrl);
      const other = await evaluated(otherLab);
      await post(reader, batch(exposure(s.result.id), exposure(other.result.id))).expect(404);
      await post(reader, batch(exposure(s.result.id), exposure(randomUUID()))).expect(404);
      expect(await stored()).toBe(0);
      expect(await otherLab.count('result_render_events', 'tenant_id = $1', [otherLab.tenant])).toBe(0); // nor in the other tenant
    });
  });

  describe('roles (FR-06)', () => {
    it('reader, clinician and reviewer store; admin is 403; the roles stored are the membership row’s', async () => {
      const s = await evaluated();
      for (const roles of [['reader'], ['clinician'], ['reviewer'], ['clinician', 'reviewer']]) {
        expect((await post(await lab.person('p', roles), batch(exposure(s.result.id))).expect(200)).body).toEqual({ stored: 1, alreadyStored: 0, withoutExposure: 0 });
      }
      await post(await lab.person('a', ['admin']), batch(exposure(s.result.id))).expect(403);
      expect(await stored()).toBe(4);
      const rows = await lab.row<{ roles: string[] }>('SELECT viewer_roles AS roles FROM result_render_events WHERE tenant_id = $1 ORDER BY received_at, viewer', [lab.tenant]);
      expect(rows.map((r) => [...r.roles].sort().join('+')).sort()).toEqual(['clinician', 'clinician+reviewer', 'reader', 'reviewer']);
    });

    it("the route's role check runs before anything is looked up: an admin is 403 even for an unknown result (a reader gets 404)", async () => {
      const missing = randomUUID();
      await post(await lab.person('a', ['admin']), batch(exposure(missing))).expect(403);
      await post(await lab.person('r', ['reader']), batch(exposure(missing))).expect(404);
    });
  });

  describe('idempotent batches and order (FR-04, R1)', () => {
    it('a retried batch stores nothing twice and says so; a later batch with one new event stores only it', async () => {
      const s = await evaluated();
      const reader = await lab.person('r', ['reader']);
      const first = exposure(s.result.id);
      const body = batch(first, duration(first, 1, 2000));
      expect((await post(reader, body).expect(200)).body).toEqual({ stored: 2, alreadyStored: 0, withoutExposure: 0 });
      expect((await post(reader, body).expect(200)).body).toEqual({ stored: 0, alreadyStored: 2, withoutExposure: 0 });
      expect((await post(reader, batch(duration(first, 1, 2000), duration(first, 2, 3000))).expect(200)).body).toEqual({ stored: 1, alreadyStored: 1, withoutExposure: 0 });
      expect(await stored()).toBe(3);
    });

    it('two identical batches at once store each event once', async () => {
      const s = await evaluated();
      const reader = await lab.person('r', ['reader']);
      const first = exposure(s.result.id);
      const body = batch(first, duration(first, 1, 2000));
      const [a, b] = await Promise.all([post(reader, body), post(reader, body)]);
      expect([a.status, b.status]).toEqual([200, 200]);
      expect([a.body.stored, b.body.stored].sort()).toEqual([0, 2]);
      expect(await stored()).toBe(2);
    });

    it('the same episode id from another person is their own event, never a duplicate of this one', async () => {
      const s = await evaluated();
      const first = exposure(s.result.id);
      for (const name of ['r1', 'r2']) expect((await post(await lab.person(name, ['reader']), batch(first)).expect(200)).body.stored).toBe(1);
      expect(await stored()).toBe(2);
    });

    it('a duration needs its exposure: without it, it is skipped and counted, and the rest of its batch is stored; after it, or listed before it, it stores', async () => {
      const s = await evaluated();
      const reader = await lab.person('r', ['reader']);
      const first = exposure(s.result.id);
      expect((await post(reader, batch(duration(first, 1, 2000))).expect(200)).body).toEqual({ stored: 0, alreadyStored: 0, withoutExposure: 1 });
      expect(await stored()).toBe(0);
      // A lost exposure does not take another result's exposure down with it (the queue is shared by every row on the page).
      const other = exposure(s.result.id);
      expect((await post(reader, batch(other, duration(first, 1, 2000))).expect(200)).body).toEqual({ stored: 1, alreadyStored: 0, withoutExposure: 1 });
      expect(await stored()).toBe(1);
      expect((await post(reader, batch(duration(first, 1, 2000), first)).expect(200)).body).toEqual({ stored: 2, alreadyStored: 0, withoutExposure: 0 });
      // A duration on another path or result is not this exposure's.
      expect((await post(reader, batch({ ...duration(first, 2, 3000), measurement: 'focus' })).expect(200)).body).toEqual({ stored: 0, alreadyStored: 0, withoutExposure: 1 });
      expect(await stored()).toBe(3);
    });
  });

  describe('a strict schema (FR-07, P4)', () => {
    it('refuses a content field, an extra field, an oversized batch, and a sub-threshold exposure with 400, storing nothing', async () => {
      const s = await evaluated();
      const reader = await lab.person('r', ['reader']);
      await post(reader, batch(exposure(s.result.id, { drug: 'syn-drug' }))).expect(400);
      await post(reader, { ...batch(exposure(s.result.id)), patientLabel: 'x' }).expect(400);
      const many = Array.from({ length: RENDER_BATCH_MAX + 1 }, () => exposure(s.result.id));
      await post(reader, batch(...many)).expect(400);
      await post(reader, batch(exposure(s.result.id, { continuousMs: 999, cumulativeMs: 999 }))).expect(400);
      expect(await stored()).toBe(0);
      expect((await post(reader, batch(...many.slice(0, RENDER_BATCH_MAX))).expect(200)).body).toEqual({ stored: RENDER_BATCH_MAX, alreadyStored: 0, withoutExposure: 0 }); // control
    });

    it('the answer is the three counts and nothing else: no field says anything was read, seen or understood', async () => {
      const s = await evaluated();
      const res = (await post(await lab.person('r', ['reader']), batch(exposure(s.result.id))).expect(200)).body;
      expect(Object.keys(res).sort()).toEqual(['alreadyStored', 'stored', 'withoutExposure']);
    });
  });

  // The default test app makes each membership match the token on every request. Here the database alone holds memberships, so a token that still
  // says `reader` proves that the live row, not the token, decides (FR-06).
  describe('membership held by the database, not the token', () => {
    let managed: NestExpressApplication;
    beforeAll(async () => {
      managed = await createTestApp({ labReportPipeline: true, postgresUrl: db.appUrl, membershipFromTokens: false });
    }, 60_000);
    afterAll(() => managed.close());

    it('a membership whose clinical roles were replaced by admin is refused although the token still claims reader; the control stores', async () => {
      const m = new LabPipeline(managed, db.adminUrl);
      const grant = async (name: string, roles: string[]) => {
        const who = await m.person(name, roles);
        await m.row(`INSERT INTO tenants (id, display_name, created_by, changed_by) VALUES ($1, $1, 'syn-test', 'syn-test') ON CONFLICT (id) DO NOTHING`, [m.tenant]);
        await m.row(`INSERT INTO tenant_memberships (tenant_id, sub, status, roles, changed_by) VALUES ($1, $2, 'active', $3::text[], 'syn-test')`, [m.tenant, who.sub, roles]);
        return who;
      };
      const clinician = await grant('clin', ['clinician']);
      const reviewer = await grant('rev', ['reviewer']);
      const reader = await grant('read', ['reader']);
      const other = await grant('read2', ['reader']);
      const s: Setup = await evaluated(m, { clinician, reviewer });
      await post(other, batch(exposure(s.result.id)), m).expect(200); // control: a live reader membership works
      await m.row(`UPDATE tenant_memberships SET roles = '{admin}', changed_by = 'syn-test' WHERE tenant_id = $1 AND sub = $2`, [m.tenant, reader.sub]);
      const res = await post(reader, batch(exposure(s.result.id)), m);
      expect([401, 403]).toContain(res.status);
      expect(await m.count('result_render_events', 'tenant_id = $1', [m.tenant])).toBe(1);
    });
  });
});
