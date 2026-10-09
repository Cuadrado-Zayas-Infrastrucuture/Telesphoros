import { Logger } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { errorResponseSchema, ledgerVerifyResultSchema, readinessDtoSchema } from '@telesphoros/shared-types';
import { LAB_READER } from '../src/lab-reports/evaluations.service';
import { LEDGER_VERIFIER, LedgerMonitor, type VerifierPort } from '../src/ledger/ledger-monitor';
import { LedgerVerifier, type VerifyOptions } from '../src/ledger/verifier';
import { createTestApp, usingPostgres } from './helpers/app';
import { createEphemeralDatabase, type EphemeralDatabase, withAdmin } from './helpers/database';
import { fixturePdf, LabPipeline } from './helpers/lab-pipeline';
import { bearer } from './helpers/tokens';

// The ledger watch over HTTP (slice 5B-3.3c): readiness shows the record log, an admin can check their own tenant's log now, and a log found
// damaged stops every record write while reads and everything else carry on. Synthetic data only.

// The findings are asserted through a spy; the console copy of each would only bury the test output.
beforeAll(() => Logger.overrideLogger(false));

const gate = <T = void>() => {
  let release!: (value: T) => void;
  const promise = new Promise<T>((resolve) => { release = resolve; });
  return { promise, release };
};

/** The real verifier, which a test can hold at chosen points. */
class ControlledVerifier implements VerifierPort {
  tenantCalls = 0;
  holdTenantsOnCall: { call: number; until: Promise<void> } | null = null;
  holdVerify: { until: Promise<void>; entered: () => void } | null = null;
  constructor(readonly inner: LedgerVerifier) {}
  async tenants() {
    this.tenantCalls += 1;
    if (this.holdTenantsOnCall?.call === this.tenantCalls) await this.holdTenantsOnCall.until;
    return this.inner.tenants();
  }
  async verify(tenantId: string, options?: VerifyOptions) {
    if (this.holdVerify && options?.budgetMs === 30_000) { // only the admin endpoint's own request (its budget) is held, never the background walk
      this.holdVerify.entered();
      await this.holdVerify.until;
    }
    return this.inner.verify(tenantId, options);
  }
  recordIncident(finding: Parameters<LedgerVerifier['recordIncident']>[0]) { return this.inner.recordIncident(finding); }
  openIncidents() { return this.inner.openIncidents(); }
  close() { return this.inner.close(); }
}

(usingPostgres() ? describe : describe.skip)('the ledger watch over HTTP', () => {
  describe('readiness and the admin check', () => {
    let db: EphemeralDatabase;
    let app: NestExpressApplication;
    let lab: LabPipeline;
    let controlled: ControlledVerifier;
    const startWalk = gate();
    beforeAll(async () => {
      db = await createEphemeralDatabase();
      controlled = new ControlledVerifier(LedgerVerifier.connect(db.verifierUrl));
      controlled.holdTenantsOnCall = { call: 2, until: startWalk.promise }; // call 1 is the check at start; call 2 is the full walk after it
      app = await createTestApp({ labReportPipeline: true, postgresUrl: db.appUrl, overrides: [{ provide: LEDGER_VERIFIER, useValue: controlled }] });
      lab = new LabPipeline(app, db.adminUrl);
    }, 60_000);
    afterAll(async () => {
      startWalk.release();
      await app.close();
      await db.drop();
    });

    const ready = () => lab.api().get('/api/v1/ready');
    const verify = (token: string, query = '') => lab.api().get(`/api/v1/ledger/verify${query}`).set(bearer(token));

    it('shows the log as "verifying" while the full walk after start runs (the instance is ready), then "up"', async () => {
      const during = await ready().expect(200);
      expect(readinessDtoSchema.safeParse(during.body).success).toBe(true);
      expect(during.body.checks).toEqual({ database: 'up', migrations: 'up', ledger: 'verifying' });
      startWalk.release();
      await app.get(LedgerMonitor).idle();
      expect((await ready().expect(200)).body.checks).toEqual({ database: 'up', migrations: 'up', ledger: 'up' });
    });

    it('lets only an admin ask (401 without a token; 403 for reader, clinician and reviewer)', async () => {
      await lab.api().get('/api/v1/ledger/verify').expect(401);
      for (const role of ['reader', 'clinician', 'reviewer']) {
        const person = await lab.person(role, [role]);
        const res = await verify(person.token).expect(403);
        expect(res.body.error.code).toBe('FORBIDDEN');
      }
      const admin = await lab.person('adm', ['admin']);
      await verify(admin.token).expect(200);
    });

    it('checks the caller\'s OWN tenant: an answer in the documented shape, from the checkpoint by default and the whole chain with full=true, recording a checkpoint', async () => {
      const clin = await lab.person('clin', ['clinician']);
      await lab.reviewedCapture(fixturePdf('D01'), { clinician: clin });
      const admin = await lab.person('adm', ['admin']);

      const first = (await verify(admin.token).expect(200)).body;
      expect(ledgerVerifyResultSchema.safeParse(first).success).toBe(true);
      expect(first).toMatchObject({ status: 'ok', mode: 'full', failures: [], eventsChecked: 2 }); // no checkpoint yet, so the "tail" is the whole chain
      expect(first.checkpointId).toEqual(expect.any(String));

      const full = (await verify(admin.token, '?full=true').expect(200)).body;
      expect(full).toMatchObject({ status: 'ok', mode: 'full', failures: [] });
      expect(full.eventsChecked).toBeGreaterThan(first.eventsChecked);

      const tail = (await verify(admin.token, '?full=false').expect(200)).body;
      expect(tail).toMatchObject({ status: 'ok', mode: 'tail', eventsChecked: 1 }); // only the checkpoint written by the previous check
      expect(await lab.count('ledger_checkpoints', 'tenant_id = $1', [lab.tenant])).toBe(3);
    });

    it('answers with kinds and sequence numbers only: no tenant, no person, no note text', async () => {
      const other = new LabPipeline(app, db.adminUrl);
      const clin = await other.person('clin', ['clinician']);
      const rev = await other.person('rev', ['reviewer']);
      const s = await other.reviewedCapture(fixturePdf('D01'), { clinician: clin, reviewer: rev });
      await other.decide(rev, s.captureId, { decision: 'rejected', note: 'SYN-SECRET-NOTE-TEXT' }).expect(201);
      expect(await other.count('event_notes', "body = 'SYN-SECRET-NOTE-TEXT'")).toBe(1); // control: the text exists, so its absence below means something
      const admin = await other.person('adm', ['admin']);
      const res = await verify(admin.token, '?full=true').expect(200);
      const text = JSON.stringify(res.body);
      for (const forbidden of [other.tenant, clin.sub, rev.sub, admin.sub, 'SYN-SECRET-NOTE-TEXT']) expect(text).not.toContain(forbidden);
      expect(Object.keys(res.body).sort()).toEqual(['checkpointId', 'eventsChecked', 'failures', 'headHash', 'headSeq', 'mode', 'status']);
    });

    it('refuses anything but the documented query (a tenant cannot be named, full is true or false)', async () => {
      const admin = await lab.person('adm', ['admin']);
      for (const query of ['?full=maybe', '?full=1', '?tenantId=somebody-else', '?full=true&extra=1']) {
        const res = await verify(admin.token, query).expect(400);
        expect(res.body.error.code).toBe('VALIDATION_ERROR');
      }
    });

    it('answers 503 PIPELINE_BUSY with Retry-After while another check is running, and works again after', async () => {
      const admin = await lab.person('adm', ['admin']);
      const entered = gate();
      const release = gate();
      controlled.holdVerify = { until: release.promise, entered: entered.release };
      const first = verify(admin.token).then((r) => r);
      await entered.promise;
      const refused = await verify(admin.token).expect(503);
      expect(refused.body.error.code).toBe('PIPELINE_BUSY');
      expect(refused.headers['retry-after']).toBe('5');
      expect(errorResponseSchema.safeParse(refused.body).success).toBe(true);
      release.release();
      expect((await first).status).toBe(200);
      controlled.holdVerify = null;
      await verify(admin.token).expect(200);
    });

    it('checks only the caller\'s tenant: damage in another tenant is not reported to this admin, and latches nothing', async () => {
      const damaged = new LabPipeline(app, db.adminUrl);
      const clin = await damaged.person('clin', ['clinician']);
      await damaged.reviewedCapture(fixturePdf('D01'), { clinician: clin });
      await withAdmin(db.adminUrl, async (c) => {
        await c.query(`SET session_replication_role = replica`);
        await c.query(`UPDATE report_captures SET text_scalars = text_scalars + 1 WHERE tenant_id = $1`, [damaged.tenant]);
      });
      // Control: the damage is real, as the verifier sees it.
      const direct = LedgerVerifier.connect(db.verifierUrl);
      try {
        expect((await direct.verify(damaged.tenant)).status).toBe('failed');
      } finally {
        await direct.close();
      }
      const neighbour = await lab.person('adm', ['admin']);
      expect((await verify(neighbour.token, '?full=true').expect(200)).body.status).toBe('ok');
      await ready().expect(200);
    });
  });

  describe('when the log is found damaged', () => {
    let db: EphemeralDatabase;
    let app: NestExpressApplication;
    let lab: LabPipeline;
    beforeAll(async () => {
      db = await createEphemeralDatabase();
      app = await createTestApp({ labReportPipeline: true, postgresUrl: db.appUrl });
      lab = new LabPipeline(app, db.adminUrl);
    }, 60_000);
    afterAll(async () => {
      await app.close();
      await db.drop();
    });

    const ready = () => lab.api().get('/api/v1/ready');

    it('stops every record write of that tenant (503 LEDGER_COMPROMISED, nothing stored, reader not run), reports "contained" (still ready), and leaves reads, other writes and other tenants alone', async () => {
      await app.get(LedgerMonitor).idle();
      const clin = await lab.person('clin', ['clinician']);
      const rev = await lab.person('rev', ['reviewer']);
      const admin = await lab.person('adm', ['admin']);
      const evaluated = await lab.reviewedCapture(fixturePdf('D01'), { clinician: clin, reviewer: rev });
      const toEvaluate = await lab.reviewedCapture(fixturePdf('D02'), { clinician: clin, reviewer: rev });
      const pending = await lab.uploadedLabPdf(clin, fixturePdf('D03'));
      const reader = app.get(LAB_READER) as { read: (text: string) => Promise<unknown> };
      const read = jest.spyOn(reader, 'read');

      // Controls: before the damage, all of these succeed.
      await lab.evaluate(clin, evaluated.reportId, { captureId: evaluated.captureId, acceptanceId: evaluated.acceptanceId }).expect(201);
      expect(read).toHaveBeenCalledTimes(1);
      await ready().expect(200);

      await withAdmin(db.adminUrl, async (c) => {
        await c.query(`SET session_replication_role = replica`);
        await c.query(`UPDATE report_captures SET text_scalars = text_scalars + 1 WHERE tenant_id = $1`, [lab.tenant]);
      });
      const logged = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      const found = await lab.api().get('/api/v1/ledger/verify?full=true').set(bearer(admin.token)).expect(200);
      expect(found.body.status).toBe('failed');
      expect(found.body.failures.map((f: { kind: string }) => f.kind)).toContain('payload-mismatch');

      // One structured line for an alarm to match on: the event, the tenant, the kinds and sequence numbers. Never a value.
      const line = logged.mock.calls.flat().find((c) => c?.event === 'ledger-compromised');
      expect(line).toMatchObject({ event: 'ledger-compromised', source: 'on-demand', tenantId: lab.tenant, failures: expect.arrayContaining([{ kind: 'payload-mismatch', seq: expect.any(String) }]) });
      expect(JSON.stringify(logged.mock.calls)).not.toMatch(/text_scalars|sample\.pdf|SYN-/);

      const rows = async () => [await lab.count('report_captures'), await lab.count('evaluations'), await lab.count('capture_acceptances'), await lab.count('ledger_events')];
      const before = await rows();

      const refusals = [
        lab.capture(clin, pending.reportId),
        lab.decide(rev, toEvaluate.captureId, { decision: 'rejected' }),
        lab.evaluate(clin, toEvaluate.reportId, { captureId: toEvaluate.captureId, acceptanceId: toEvaluate.acceptanceId }),
      ];
      for (const refusal of refusals) {
        const res = await refusal.expect(503);
        expect(errorResponseSchema.safeParse(res.body).success).toBe(true);
        expect(res.body.error.code).toBe('LEDGER_COMPROMISED');
        expect(res.headers['retry-after']).toBeUndefined(); // waiting cannot clear it
        expect(JSON.stringify(res.body)).not.toMatch(/payload-mismatch|tenant-/);
      }
      expect(read).toHaveBeenCalledTimes(1); // the evaluation was refused before the reader ran
      expect(await rows()).toEqual(before); // nothing was stored by any of them

      // The instance stays ready for everyone else; the public body says "contained" and names no tenant.
      const stillReady = await lab.api().get('/api/v1/ready').expect(200);
      expect(readinessDtoSchema.safeParse(stillReady.body).success).toBe(true);
      expect(stillReady.body.checks.ledger).toBe('contained');
      expect(JSON.stringify(stillReady.body)).not.toContain(lab.tenant);
      await lab.api().get('/api/v1/health').expect(200);

      // The finding is in the DATABASE, so a task that never walked this tenant is stopped too.
      expect(await withAdmin(db.adminUrl, async (c) => (await c.query(`SELECT tenant_id, scope FROM ledger_incidents`)).rows)).toEqual([{ tenant_id: lab.tenant, scope: 'tenant' }]);

      // Another tenant is not affected.
      const neighbour = new LabPipeline(app, db.adminUrl);
      const neighbourClinician = await neighbour.person('clin', ['clinician']);
      await neighbour.reviewedCapture(fixturePdf('D01'), { clinician: neighbourClinician });

      // Reads work, writes that are not ledger records work, and the admin can still look.
      await lab.api().get(`/api/v1/captures/${evaluated.captureId}`).set(bearer(rev.token)).expect(200);
      await lab.api().get('/api/v1/evaluations').set(bearer(rev.token)).expect(200);
      await lab.api().get('/api/v1/cell-disputes').set(bearer(rev.token)).expect(200);
      await lab.api().post('/api/v1/patients').set(bearer(clin.token)).send({ label: 'SYN-AFTER-LATCH' }).expect(201);
      expect((await lab.api().get('/api/v1/ledger/verify').set(bearer(admin.token)).expect(200)).body.status).toBe('failed');
      logged.mockRestore();
    });
  });
});
