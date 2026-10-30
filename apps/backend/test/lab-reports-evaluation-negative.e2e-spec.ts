import { ConsoleLogger, Logger } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { LedgerRecordsRepository } from '../src/storage/ledger-records.repository';
import { LAB_READER } from '../src/lab-reports/evaluations.service';
import { ObjectStorage } from '../src/object-storage/object-storage';
import type { ReportReader } from '../src/services/report-reader/report-reader';
import { failureResult, type ReaderResult } from '../src/services/report-reader/reader-result';
import { createTestApp, usingPostgres } from './helpers/app';
import { StandInReportReader } from './helpers/stand-in-reader';
import { createEphemeralDatabase, type EphemeralDatabase } from './helpers/database';
import { bearer } from './helpers/tokens';
import { fixturePdf, fixtureText, LabPipeline, sha } from './helpers/lab-pipeline';

// What the evaluation endpoint refuses, how it behaves when the reader fails or is busy, and that it is idempotent. Every refusal is
// asserted to have stored NOTHING, and each has a control that must succeed. Synthetic data only.
// The limiter tests below gate a reader that delegates to the test stand-in: they test the limit and the abort, not the reader.
const real = new StandInReportReader();

(usingPostgres() ? describe : describe.skip)('lab-report evaluation: refusals, failures and idempotency', () => {
  let db: EphemeralDatabase;
  let app: NestExpressApplication;
  let lab: LabPipeline;
  const extraApps: NestExpressApplication[] = [];
  beforeAll(async () => {
    db = await createEphemeralDatabase();
    app = await createTestApp({ labReportPipeline: true, postgresUrl: db.appUrl });
    lab = new LabPipeline(app, db.adminUrl);
  }, 60_000);
  afterAll(async () => {
    await Promise.all(extraApps.map((a) => a.close()));
    await app.close();
    await db.drop();
  });

  const evaluations = (tenant = lab.tenant) => lab.count('evaluations', 'tenant_id = $1', [tenant]);
  const body = (s: { captureId: string; acceptanceId: string }) => ({ captureId: s.captureId, acceptanceId: s.acceptanceId });
  const other = async (options: NonNullable<Parameters<typeof createTestApp>[0]>) => {
    // Every extra app shares the first app's object storage, so the files and text it wrote are visible (in memory or over S3 alike).
    const overrides = [{ provide: ObjectStorage, useValue: app.get(ObjectStorage) }, ...(options.overrides ?? [])];
    const extra = await createTestApp({ labReportPipeline: true, postgresUrl: db.appUrl, ...options, overrides });
    extraApps.push(extra);
    return new LabPipeline(extra, db.adminUrl, lab.tenant);
  };

  describe('what must be true before the reader runs', () => {
    it('a capture nobody accepted, or one that was rejected, is 409 capture-not-accepted', async () => {
      const clin = await lab.person('clin', ['clinician']);
      const up = await lab.uploadedLabPdf(clin, fixturePdf('D01'));
      const capture = (await lab.capture(clin, up.reportId).expect(201)).body.id as string;
      const reviewer = await lab.person('rev', ['reviewer']);
      const rejected = (await lab.decide(reviewer, capture, { decision: 'rejected' }).expect(201)).body.id as string;
      const before = await evaluations();
      const res = await lab.evaluate(clin, up.reportId, { captureId: capture, acceptanceId: rejected }).expect(409);
      expect(res.body.error.details[0].reason).toBe('capture-not-accepted');
      expect(await evaluations()).toBe(before);
    });

    it('a decision that a later decision supersedes is stale: 409 even when the result already exists; history is read with GET', async () => {
      const s = await lab.reviewedCapture(fixturePdf('D01'));
      const first = await lab.evaluate(s.clinician, s.reportId, body(s)).expect(201);
      // A different reviewer now REJECTS the same capture: the accepted decision is no longer the latest.
      await lab.decide(await lab.person('rev2', ['reviewer']), s.captureId, { decision: 'rejected' }).expect(201);
      const stale = await lab.evaluate(s.clinician, s.reportId, body(s)).expect(409);
      expect(stale.body.error.details[0].reason).toBe('stale-acceptance');
      const read = await lab.api().get(`/api/v1/evaluations/${first.body.id}`).set(bearer(s.clinician.token)).expect(200);
      expect(read.body.acceptance).toMatchObject({ id: s.acceptanceId, current: false }); // still readable, and marked as no longer current
      // Control: a fresh acceptance by a third person is current, and evaluating from it works.
      const fresh = (await lab.decide(await lab.person('rev3', ['reviewer']), s.captureId, { decision: 'accepted' }).expect(201)).body.id as string;
      await lab.evaluate(s.clinician, s.reportId, { captureId: s.captureId, acceptanceId: fresh }).expect(201);
    });

    it('a NEWER capture of the same report, left unaccepted, does not invalidate an older accepted one', async () => {
      const s = await lab.reviewedCapture(fixturePdf('D02'));
      const row = (
        await lab.row<{ storage_key: string; sha256: string; object_version: string; patient_id: string }>(
          `SELECT storage_key, sha256, object_version, patient_id FROM reports WHERE id = $1`,
          [s.reportId],
        )
      )[0]!;
      await app.get(LedgerRecordsRepository).insertCapture(lab.tenant, 'syn-capturer', {
        reportId: s.reportId,
        expectedReport: { patientId: row.patient_id, sha256: row.sha256, objectVersion: row.object_version, storageKey: row.storage_key },
        pdfSha256: row.sha256,
        textStorageKey: `reports/x/${s.reportId}/text/another`,
        textSha256: sha('another reading'),
        textScalars: 15,
        popplerVersion: '26.03.0',
        runner: 'fake',
        origin: 'synthetic',
      });
      expect(await lab.count('report_captures', 'report_id = $1', [s.reportId])).toBe(2);
      await lab.evaluate(s.clinician, s.reportId, body(s)).expect(201);
    });

    it('ids that do not belong together are refused (409 mismatch), unknown or foreign ones are 404', async () => {
      const a = await lab.reviewedCapture(fixturePdf('D01'));
      const b = await lab.reviewedCapture(fixturePdf('D02'));
      const before = await evaluations();
      expect((await lab.evaluate(a.clinician, a.reportId, { captureId: b.captureId, acceptanceId: b.acceptanceId }).expect(409)).body.error.details[0].reason).toBe('mismatch');
      expect((await lab.evaluate(a.clinician, a.reportId, { captureId: a.captureId, acceptanceId: b.acceptanceId }).expect(409)).body.error.details[0].reason).toBe('mismatch');
      const none = '00000000-0000-4000-8000-000000000000';
      await lab.evaluate(a.clinician, a.reportId, { captureId: none, acceptanceId: a.acceptanceId }).expect(404);
      await lab.evaluate(a.clinician, none, body(a)).expect(404);
      const stranger = await lab.person('m', ['clinician'], 'tenant-two');
      await lab.evaluate(stranger, a.reportId, body(a)).expect(404);
      expect(await evaluations()).toBe(before);
    });

    it('the stored text must still be the captured text: replaced text is 409 text-hash-mismatch', async () => {
      const s = await lab.reviewedCapture(fixturePdf('D03'));
      const key = (await lab.row<{ text_storage_key: string }>(`SELECT text_storage_key FROM report_captures WHERE id = $1`, [s.captureId]))[0]!.text_storage_key;
      await app.get(ObjectStorage).putObject(key, Buffer.from('replaced text'), 'text/plain');
      const res = await lab.evaluate(s.clinician, s.reportId, body(s)).expect(409);
      expect(res.body.error.details[0].reason).toBe('text-hash-mismatch');
      expect(await lab.count('evaluations', 'report_id = $1', [s.reportId])).toBe(0);
    });

    it('an active dispute does not refuse an evaluation any more (the overlay holds only its cell); reads show how many are active', async () => {
      // Before slice 5B-3.3b any dispute in the tenant refused every new evaluation (409 dispute-active). Now a dispute that names no cell of the
      // loaded knowledge changes nothing, and one that does hold only its own cell (lab-reports-disputes.e2e-spec.ts).
      const t = `tenant-d-${Math.random().toString(36).slice(2, 8)}`;
      const local = new LabPipeline(app, db.adminUrl, t);
      const clin = await local.person('clin', ['clinician']);
      const rev = await local.person('rev', ['reviewer']);
      const s1 = await local.reviewedCapture(fixturePdf('D01'), { clinician: clin, reviewer: rev });
      const s2 = await local.reviewedCapture(fixturePdf('D02'), { clinician: clin, reviewer: rev });
      const before = await local.evaluate(clin, s1.reportId, body(s1)).expect(201);
      const ledger = app.get(LedgerRecordsRepository);
      const raised = await ledger.raiseDispute(t, 'syn-disputer', {
        guidelineId: 'g',
        guidelineVersion: '1',
        guidelineContentSha256: 'c'.repeat(64),
        locator: { table: 'r', row: 'x' },
        note: 'wrong cell',
      });
      const during = await local.evaluate(clin, s2.reportId, body(s2)).expect(201);
      expect(during.body.knowledgeSetId).toBe(before.body.knowledgeSetId); // no cell of the loaded knowledge was disputed: the same effective set
      const read = await local.api().get(`/api/v1/evaluations/${before.body.id}`).set(bearer(clin.token)).expect(200);
      expect(read.body).toMatchObject({ advisory: { activeDisputes: 1 }, actionable: false, clinicalUse: 'not-approved' });
      await ledger.decideDispute(t, 'syn-decider', { disputeId: raised.record.id, decision: 'dismissed', evidenceNote: 'the cell is right' });
      expect((await local.api().get(`/api/v1/evaluations/${before.body.id}`).set(bearer(clin.token))).body.advisory.activeDisputes).toBe(0);
    });

    it('needs a role that may evaluate (reader, administrator and no role are 403), and takes only the two ids', async () => {
      const s = await lab.reviewedCapture(fixturePdf('D04'));
      for (const roles of [['reader'], ['admin'], []]) await lab.evaluate(await lab.person('x', roles), s.reportId, body(s)).expect(403);
      for (const bad of [{}, { captureId: s.captureId }, { ...body(s), extra: 1 }, { captureId: 'x', acceptanceId: s.acceptanceId }])
        await lab.evaluate(s.clinician, s.reportId, bad).expect(400);
      expect([200, 201]).toContain((await lab.evaluate(await lab.person('adm', ['admin', 'clinician']), s.reportId, body(s))).status);
      expect([200, 201]).toContain((await lab.evaluate(await lab.person('rv', ['reviewer']), s.reportId, body(s))).status);
    });
  });

  describe('idempotency: one durable result per fingerprint', () => {
    it('six concurrent identical requests give one evaluation and one ledger event; a replay is 200 and adds nothing', async () => {
      const s = await lab.reviewedCapture(fixturePdf('D01'));
      const roomy = await other({ maxConcurrentReads: 8 }); // the default cap of 2 would (correctly) turn some of these away with 503
      const responses = await Promise.all(Array.from({ length: 6 }, () => roomy.evaluate(s.clinician, s.reportId, body(s))));
      expect(responses.map((r) => r.status).sort()).toEqual([200, 200, 200, 200, 200, 201]);
      expect(new Set(responses.map((r) => r.body.id)).size).toBe(1);
      const id = responses[0]!.body.id as string;
      expect(await lab.count('evaluations', 'report_id = $1', [s.reportId])).toBe(1);
      expect(await lab.count('ledger_events', `subject_table = 'evaluations' AND subject_id = $1`, [id])).toBe(1);
      const replay = await lab.evaluate(s.clinician, s.reportId, body(s)).expect(200);
      expect(replay.body.id).toBe(id);
      expect(await lab.count('ledger_events', `subject_table = 'evaluations' AND subject_id = $1`, [id])).toBe(1);
    });

    it('a different build is a different fingerprint (a new record); the same PDF in another report or tenant never shares a result', async () => {
      const s = await lab.reviewedCapture(fixturePdf('D01'));
      const first = await lab.evaluate(s.clinician, s.reportId, body(s)).expect(201);
      const newBuild = await other({ buildVersion: 'test-build-2' });
      const second = await newBuild.evaluate(s.clinician, s.reportId, body(s)).expect(201);
      expect(second.body.id).not.toBe(first.body.id);
      expect(second.body.engineVersion).toBe('test-build-2');
      expect(await lab.count('evaluations', 'report_id = $1', [s.reportId])).toBe(2);

      const twin = await lab.reviewedCapture(fixturePdf('D01'));
      const twinResult = await lab.evaluate(twin.clinician, twin.reportId, body(twin)).expect(201);
      expect(twinResult.body.id).not.toBe(first.body.id);
      const foreign = new LabPipeline(app, db.adminUrl, 'tenant-foreign');
      const f = await foreign.reviewedCapture(fixturePdf('D01'));
      const foreignResult = await foreign.evaluate(f.clinician, f.reportId, body(f)).expect(201);
      expect(foreignResult.body.id).not.toBe(first.body.id);
      expect(await foreign.count('evaluations', 'tenant_id = $1', ['tenant-foreign'])).toBe(1);
    });
  });

  describe('when the reader does not give a usable answer', () => {
    const readerReturning = (result: ReaderResult | Error): ReportReader => ({
      read: async () => {
        if (result instanceof Error) throw result;
        return result;
      },
    });

    it.each([
      ['source-time-budget', 30],
      ['worker-error', 30],
    ] as const)('%s is 503 READER_UNAVAILABLE with Retry-After %i, stores nothing, and the same request works once the reader does', async (reason, retryAfter) => {
      const s = await lab.reviewedCapture(fixturePdf('D05'));
      const failing = await other({ overrides: [{ provide: LAB_READER, useValue: readerReturning(failureResult(reason)) }] });
      const res = await failing.evaluate(s.clinician, s.reportId, body(s)).expect(503);
      expect(res.body.error.code).toBe('READER_UNAVAILABLE');
      expect(res.headers['retry-after']).toBe(String(retryAfter));
      expect(await lab.count('evaluations', 'report_id = $1', [s.reportId])).toBe(0);
      expect(
        await lab.count(
          'ledger_events',
          `event_type = 'evaluation' AND tenant_id = $1 AND created_at > now() - interval '1 minute' AND subject_id IN (SELECT id FROM evaluations WHERE report_id = $2)`,
          [lab.tenant, s.reportId],
        ),
      ).toBe(0);
      await lab.evaluate(s.clinician, s.reportId, body(s)).expect(201); // no key was consumed by the failure
    });

    it('a fact about the text (source-limit, candidate-or-frame-limit) is stored as a held evaluation, not an error', async () => {
      for (const reason of ['source-limit', 'candidate-or-frame-limit'] as const) {
        const s = await lab.reviewedCapture(fixturePdf('D06'));
        const limited = await other({ overrides: [{ provide: LAB_READER, useValue: readerReturning(failureResult(reason)) }] });
        const res = await limited.evaluate(s.clinician, s.reportId, body(s)).expect(201);
        expect(res.body).toMatchObject({ disposition: 'held', holdCode: reason, results: [], hold: { message: expect.any(String) } });
      }
    });

    it('a reader that throws is a server error, not a stored result, and does not leak capacity', async () => {
      const throwing = await other({ maxConcurrentReads: 1, overrides: [{ provide: LAB_READER, useValue: readerReturning(new Error('boom: report text must not appear')) }] });
      const s = await lab.reviewedCapture(fixturePdf('D07'));
      for (let attempt = 0; attempt < 3; attempt++) {
        const res = await throwing.evaluate(s.clinician, s.reportId, body(s)).expect(500);
        expect(JSON.stringify(res.body)).not.toContain('boom');
      }
      expect(await lab.count('evaluations', 'report_id = $1', [s.reportId])).toBe(0);
    });
  });

  describe('the reader limit (per process)', () => {
    it('a full limiter answers 503 PIPELINE_BUSY with Retry-After at once, holds NO database transaction while the reader works, and frees the slot afterwards', async () => {
      let release!: () => void;
      let started!: () => void;
      const running = new Promise<void>((resolve) => (started = resolve));
      const gate = new Promise<void>((resolve) => (release = resolve));
      const slow: ReportReader = {
        read: async (text) => {
          started();
          await gate;
          return real.read(text);
        },
      };
      const gated = await other({ maxConcurrentReads: 1, overrides: [{ provide: LAB_READER, useValue: slow }] });
      const s1 = await lab.reviewedCapture(fixturePdf('D01'));
      const s2 = await lab.reviewedCapture(fixturePdf('D02'));

      const first = gated.evaluate(s1.clinician, s1.reportId, body(s1)).then((r) => r);
      await running; // the first request is inside the reader now

      // Only this test's own database: other suites hold transactions open on purpose, in their own databases, at the same time.
      const idle = await lab.count('pg_stat_activity', `datname = $1 AND usename = 'telesphoros_test_app' AND state = 'idle in transaction'`, [db.name]);
      expect(idle).toBe(0); // nothing holds a transaction open while a slow reader works

      const busy = await gated.evaluate(s2.clinician, s2.reportId, body(s2));
      expect(busy.status).toBe(503);
      expect(busy.body.error.code).toBe('PIPELINE_BUSY');
      expect(busy.headers['retry-after']).toBe('5');
      expect(await lab.count('evaluations', 'report_id = $1', [s2.reportId])).toBe(0); // nothing queued, nothing stored

      release();
      expect((await first).status).toBe(201);
      expect((await gated.evaluate(s2.clinician, s2.reportId, body(s2))).status).toBe(201); // the slot came back
    });

    it('a client that gives up does not cancel the read; the work finishes, is stored once, and capacity comes back', async () => {
      let release!: () => void;
      let started!: () => void;
      const running = new Promise<void>((resolve) => (started = resolve));
      const gate = new Promise<void>((resolve) => (release = resolve));
      const slow: ReportReader = {
        read: async (text) => {
          started();
          await gate;
          return real.read(text);
        },
      };
      const gated = await other({ maxConcurrentReads: 1, overrides: [{ provide: LAB_READER, useValue: slow }] });
      const s = await lab.reviewedCapture(fixturePdf('D01'));
      const controller = new AbortController();
      const port = (gated.app.getHttpServer().address() as { port: number }).port;
      const abandoned = fetch(`http://127.0.0.1:${port}/api/v1/reports/${s.reportId}/evaluations`, {
        method: 'POST',
        headers: { ...bearer(s.clinician.token), 'Content-Type': 'application/json' },
        body: JSON.stringify(body(s)),
        signal: controller.signal,
      }).catch(() => 'aborted');
      await running;
      controller.abort(); // the caller leaves while the reader is still working
      expect(await abandoned).toBe('aborted');
      release();
      const deadline = Date.now() + 10_000;
      while ((await lab.count('evaluations', 'report_id = $1', [s.reportId])) === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
      expect(await lab.count('evaluations', 'report_id = $1', [s.reportId])).toBe(1); // the read finished and was stored, once
      const next = await lab.reviewedCapture(fixturePdf('D02'));
      expect((await gated.evaluate(next.clinician, next.reportId, body(next))).status).toBe(201); // capacity came back
    });
  });

  describe('logs and errors', () => {
    it('nothing in what the service logs for a full run, a refusal or a reader failure contains report text, a note, a storage key or a link', async () => {
      // Built BEFORE the logger is replaced: creating a test app installs its own quiet logger, which would otherwise replace ours.
      const failing = await other({ overrides: [{ provide: LAB_READER, useValue: { read: async () => failureResult('worker-error') } }] });
      const s = await lab.reviewedCapture(fixturePdf('D01'));
      const t = await lab.reviewedCapture(fixturePdf('D02'));
      const lines: string[] = [];
      const capture = new (class extends ConsoleLogger {
        override log(...args: unknown[]) {
          lines.push(JSON.stringify(args));
        }
        override warn(...args: unknown[]) {
          lines.push(JSON.stringify(args));
        }
        override error(...args: unknown[]) {
          lines.push(JSON.stringify(args));
        }
        override debug(...args: unknown[]) {
          lines.push(JSON.stringify(args));
        }
        override verbose(...args: unknown[]) {
          lines.push(JSON.stringify(args));
        }
      })();
      Logger.overrideLogger(capture);
      try {
        await lab.evaluate(s.clinician, s.reportId, body(s)).expect(201);
        await lab.evaluate(s.clinician, s.reportId, { captureId: s.captureId, acceptanceId: '00000000-0000-4000-8000-000000000000' }).expect(404);
        await failing.evaluate(t.clinician, t.reportId, body(t)).expect(503);
      } finally {
        Logger.overrideLogger(['error', 'warn']);
      }
      const logged = lines.join('\n');
      expect(logged).toContain('reader-unavailable'); // the failure is visible in the log, as a code ...
      for (const forbidden of [fixtureText('D01').slice(0, 30), 'CYP2C19 ', 'reports/', 'versionId', 'X-Amz-Signature']) expect(logged).not.toContain(forbidden); // ... and nothing else
    });
  });
});
