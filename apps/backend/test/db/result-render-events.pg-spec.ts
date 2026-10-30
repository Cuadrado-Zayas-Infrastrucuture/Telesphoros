import { randomUUID } from 'node:crypto';
import type { ResultRenderEvent } from '@telesphoros/shared-types';
import { Database } from '../../src/db/database';
import { PostgresLedgerRecordsRepository } from '../../src/storage/postgres/ledger-records.repository';
import { PostgresResultRendersRepository } from '../../src/storage/postgres/result-renders';
import { ResultRenderNotFoundError, ResultRenderNotReaderError } from '../../src/storage/result-renders';
import { Session } from '../helpers/barrier';
import { createEphemeralDatabase, type EphemeralDatabase, withAdmin } from '../helpers/database';
import { acceptanceFor, captureFor, evaluationFor, seedLabReport } from '../helpers/ledger-fixtures';
import type { PgError } from '../helpers/ledger-sql';

// Spec 019 D02b at the database: what holds even for a writer that bypasses the API (direct SQL as the application role). Expected values are written
// by hand; the oracle is the database's own refusal or the rows read through the administrator connection. Synthetic ids only.
const usingPostgres = process.env.TEST_STORAGE === 'postgres';
(usingPostgres ? describe : describe.skip)('result render events in the database', () => {
  let db: EphemeralDatabase;
  let database: Database;
  let ledger: PostgresLedgerRecordsRepository;
  let renders: PostgresResultRendersRepository;
  beforeAll(async () => {
    db = await createEphemeralDatabase();
    database = new Database({ url: db.appUrl, ssl: 'disable' });
    ledger = new PostgresLedgerRecordsRepository(database);
    renders = new PostgresResultRendersRepository(database);
  }, 60_000);
  afterAll(async () => {
    await database.onModuleDestroy();
    await db.drop();
  });

  /** A tenant with one evaluation (results[0] is shown), a reader, a clinician, a reviewer and an admin who holds no clinical role. */
  async function evaluated() {
    const tenant = `t-${randomUUID().slice(0, 8)}`;
    const people = { reader: `syn-read-${tenant}`, clinician: `syn-clin-${tenant}`, reviewer: `syn-rev-${tenant}`, admin: `syn-adm-${tenant}` };
    const report = await seedLabReport(db.adminUrl, tenant);
    const capture = captureFor(report);
    const stored = await ledger.insertCapture(tenant, report.uploader, capture);
    const acceptance = await ledger.insertAcceptance(tenant, 'syn-reviewer', acceptanceFor(stored.record.id, capture));
    await ledger.insertPatientDecision(tenant, 'syn-verifier', {
      reportId: report.reportId,
      expectedReport: { patientId: report.patientId, sha256: report.pdfSha256, objectVersion: report.objectVersion },
      decision: 'verified',
      method: 'person-confirmed',
      basisCode: 'no-identifier-on-report',
    });
    const evaluation = (await ledger.insertEvaluation(tenant, 'syn-system', evaluationFor(report, stored.record.id, acceptance.record.id))).record;
    await withAdmin(db.adminUrl, async (c) => {
      for (const [sub, roles] of [
        [people.reader, ['reader']],
        [people.clinician, ['clinician']],
        [people.reviewer, ['reviewer']],
        [people.admin, ['admin']],
      ] as const) {
        await c.query(`INSERT INTO tenant_memberships (tenant_id, sub, status, roles, changed_by) VALUES ($1, $2, 'active', $3::text[], 'syn-test')`, [tenant, sub, roles]);
      }
    });
    const results = await withAdmin(
      db.adminUrl,
      async (c) => (await c.query<{ id: string }>('SELECT id::text AS id FROM evaluation_results WHERE evaluation_id = $1 ORDER BY ordinal', [evaluation.id])).rows,
    );
    return { tenant, ...people, evaluationId: evaluation.id as string, patientId: report.patientId, result: results[0]!.id };
  }
  type Setup = Awaited<ReturnType<typeof evaluated>>;

  const count = (tenant: string) =>
    withAdmin(db.adminUrl, async (c) => (await c.query<{ n: number }>('SELECT count(*)::int AS n FROM result_render_events WHERE tenant_id = $1', [tenant])).rows[0]!.n);

  const INSERT = `INSERT INTO result_render_events (tenant_id, episode_id, seq, kind, result_id, evaluation_id, patient_id, viewer, viewer_roles,
                                                    membership_version, measurement, rule_version, schema_version, capability, occurred_at, sent_at,
                                                    continuous_ms, cumulative_ms)
                  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, '{}', 0, $9, $10, $11, $12::text[], $13, $14, $15, $16)`;
  interface Row {
    episode?: string;
    seq?: number;
    kind?: string;
    patient_id?: string;
    measurement?: string;
    rule_version?: string;
    schema_version?: number;
    capability?: string[];
    occurred_at?: string;
    sent_at?: string;
    continuous_ms?: number;
    cumulative_ms?: number;
  }
  const values = (s: Setup, viewer: string, row: Row = {}) => [
    s.tenant,
    row.episode ?? randomUUID(),
    row.seq ?? 0,
    row.kind ?? 'exposure',
    s.result,
    s.evaluationId,
    row.patient_id ?? s.patientId,
    viewer,
    row.measurement ?? 'viewport',
    row.rule_version ?? 'render-v1',
    row.schema_version ?? 1,
    row.capability ?? ['intersection-observer', 'page-visibility'],
    row.occurred_at ?? '2026-10-29T15:04:05Z',
    row.sent_at ?? '2026-10-29T15:04:06Z',
    row.continuous_ms ?? 1000,
    row.cumulative_ms ?? 1000,
  ];

  /** Direct INSERTs as the application role, in one transaction, bypassing the service and the repository. Returns the first error, if any. */
  async function direct(s: Setup, viewer: string, rows: Row[], sessionActor = viewer, commit = false): Promise<PgError | undefined> {
    const session = await Session.open(db.appUrl, `render-direct-${randomUUID().slice(0, 6)}`, s.tenant, sessionActor);
    try {
      for (const row of rows) {
        const error = await session.start(INSERT, values(s, viewer, row));
        if (error) return error;
      }
      if (commit) await session.commit();
      return undefined;
    } finally {
      await session.close();
    }
  }

  const event = (s: Setup, extra: Partial<ResultRenderEvent> = {}): ResultRenderEvent => ({
    episodeId: randomUUID(),
    seq: 0,
    kind: 'exposure',
    resultId: s.result,
    measurement: 'viewport',
    ruleVersion: 'render-v1',
    schemaVersion: 1,
    capability: ['intersection-observer', 'page-visibility', 'focus-events'],
    occurredAt: '2026-10-29T15:04:05.000Z',
    continuousMs: 1000,
    cumulativeMs: 1000,
    ...extra,
  });
  const SENT = '2026-10-29T15:04:10.000Z';

  describe('a direct INSERT as the application role', () => {
    it('an exposure by each clinical reader role is stored, with the roles and membership version from the live row and the server time (control)', async () => {
      const s = await evaluated();
      for (const viewer of [s.reader, s.clinician, s.reviewer]) expect(await direct(s, viewer, [{}], viewer, true)).toBeUndefined();
      const rows = await withAdmin(
        db.adminUrl,
        async (c) =>
          (
            await c.query<{ viewer: string; viewer_roles: string[]; membership_version: string; fresh: boolean; clock_uncertainty_ms: string }>(
              `SELECT viewer, viewer_roles, membership_version::text, received_at > now() - interval '1 minute' AS fresh, clock_uncertainty_ms::text
                 FROM result_render_events WHERE tenant_id = $1 ORDER BY viewer`,
              [s.tenant],
            )
          ).rows,
      );
      expect(rows.map((r) => [r.viewer, r.viewer_roles])).toEqual(
        [
          [s.clinician, ['clinician']],
          [s.reader, ['reader']],
          [s.reviewer, ['reviewer']],
        ].sort((a, b) => (a[0]! < b[0]! ? -1 : 1)),
      );
      expect(rows.every((r) => r.fresh && Number(r.membership_version) >= 1)).toBe(true); // the trigger overwrote '{}' and 0
      // Clock uncertainty is the server's receipt minus the client's send time: the send time given was in the past, so it is positive.
      expect(rows.every((r) => Number(r.clock_uncertainty_ms) > 0)).toBe(true);
    });

    it('an admin with no clinical role, or nobody, is refused by the trigger from the live membership row', async () => {
      const s = await evaluated();
      expect((await direct(s, s.admin, [{}]))?.code).toBe('RR001');
      expect((await direct(s, 'syn-nobody', [{}]))?.code).toBe('RR001');
    });

    it('a row whose viewer is not the person bound to the transaction is refused', async () => {
      const s = await evaluated();
      expect((await direct(s, s.reader, [{}], s.clinician))?.code).toBe('42501');
    });

    it('a row naming the wrong patient is refused by the composite foreign key', async () => {
      const s = await evaluated();
      expect((await direct(s, s.reader, [{ patient_id: randomUUID() }]))?.code).toBe('23503');
    });

    it('a duration needs its exposure for the same episode and path; with it, earlier in the same statement or transaction, it is stored', async () => {
      const s = await evaluated();
      const episode = randomUUID();
      const duration = { episode, seq: 1, kind: 'duration', continuous_ms: 3000, cumulative_ms: 3000 };
      expect((await direct(s, s.reader, [duration]))?.code).toBe('RR002');
      expect((await direct(s, s.reader, [{ episode, measurement: 'focus', capability: ['page-visibility', 'focus-events'] }, duration]))?.code).toBe('RR002'); // other path
      expect(await direct(s, s.reader, [{ episode }, duration])).toBeUndefined(); // control
    });

    it('FR-04: a second row for the same viewer, episode and seq is refused by the key, even in one transaction', async () => {
      const s = await evaluated();
      const episode = randomUUID();
      const second = await direct(s, s.reader, [{ episode }, { episode }]);
      expect(second?.code).toBe('23505');
      expect(second?.constraint).toBe('result_render_events_once_uq');
    });

    it.each([
      ['an exposure under one second', { continuous_ms: 999, cumulative_ms: 999 }, 'result_render_events_ms'],
      ['cumulative under continuous', { continuous_ms: 2000, cumulative_ms: 1500 }, 'result_render_events_ms'],
      ['an exposure at seq 1', { seq: 1 }, 'result_render_events_kind_seq'],
      ['an unknown kind', { kind: 'view' }, 'result_render_events_kind'],
      ['an unknown path', { measurement: 'scroll' }, 'result_render_events_measurement'],
      ['another rule version', { rule_version: 'render-v2' }, 'result_render_events_rule_version'],
      ['another schema version', { schema_version: 2 }, 'result_render_events_schema_version'],
      ['viewport measured without intersection-observer', { capability: ['page-visibility', 'focus-events'] }, 'result_render_events_capability'],
      ['an unknown capability', { capability: ['page-visibility', 'intersection-observer', 'mouse'] }, 'result_render_events_capability'],
      ['an event sent before it occurred', { sent_at: '2026-10-29T15:04:04Z' }, 'result_render_events_client_times'],
    ])('%s is refused by its CHECK', async (_label, row, constraint) => {
      const s = await evaluated();
      expect((await direct(s, s.reader, [row]))?.constraint).toBe(constraint);
    });
  });

  describe('append-only and isolated', () => {
    it('a stored row cannot be updated or deleted by the application, nor updated, deleted or truncated by the owner', async () => {
      const s = await evaluated();
      expect(await direct(s, s.reader, [{}], s.reader, true)).toBeUndefined();
      for (const sql of [`UPDATE result_render_events SET continuous_ms = 5000`, `DELETE FROM result_render_events`]) {
        const session = await Session.open(db.appUrl, 'render-mutate', s.tenant, s.reader);
        try {
          expect([sql, (await session.start(sql))?.message]).toEqual([sql, expect.stringMatching(/append-only|not allowed|refuse|permission denied/i)]);
        } finally {
          await session.close();
        }
      }
      for (const sql of [`UPDATE result_render_events SET continuous_ms = 5000`, `DELETE FROM result_render_events`, `TRUNCATE result_render_events`]) {
        await expect(withAdmin(db.adminUrl, (c) => c.query(sql))).rejects.toThrow();
      }
      expect(await count(s.tenant)).toBe(1);
    });

    it("another organization's session sees none of the rows, and cannot insert one for this tenant", async () => {
      const s = await evaluated();
      expect(await direct(s, s.reader, [{}], s.reader, true)).toBeUndefined();
      const other = await Session.open(db.appUrl, 'render-other', `${s.tenant}-other`, s.reader);
      try {
        expect((await other.client.query('SELECT count(*)::int AS n FROM result_render_events')).rows[0].n).toBe(0);
        expect((await other.start(INSERT, values(s, s.reader)))?.code).toBe('42501'); // the trigger's binding check, before the policy's
      } finally {
        await other.close();
      }
      expect(await count(s.tenant)).toBe(1);
    });
  });

  describe('the repository', () => {
    it('stores an exposure and its durations, and a retried batch stores nothing twice', async () => {
      const s = await evaluated();
      const exposure = event(s);
      const durations = [1, 2].map((seq) => event(s, { episodeId: exposure.episodeId, seq, kind: 'duration', continuousMs: 1000 + seq * 1000, cumulativeMs: 1000 + seq * 1000 }));
      // Out of order on purpose: the repository puts each exposure before its durations.
      expect(await renders.record(s.tenant, s.reader, { sentAt: SENT, events: [durations[1]!, exposure, durations[0]!] })).toEqual({
        stored: 3,
        alreadyStored: 0,
        withoutExposure: 0,
      });
      expect(await renders.record(s.tenant, s.reader, { sentAt: SENT, events: [exposure, ...durations] })).toEqual({ stored: 0, alreadyStored: 3, withoutExposure: 0 });
      const next = event(s, { episodeId: exposure.episodeId, seq: 3, kind: 'duration', continuousMs: 4000, cumulativeMs: 4000 });
      expect(await renders.record(s.tenant, s.reader, { sentAt: SENT, events: [durations[1]!, next] })).toEqual({ stored: 1, alreadyStored: 1, withoutExposure: 0 }); // exposure stored before
      expect(await count(s.tenant)).toBe(4);
    });

    it("refuses a batch naming another tenant's result, or no result, and stores none of it", async () => {
      const s = await evaluated();
      const t = await evaluated();
      await expect(renders.record(s.tenant, s.reader, { sentAt: SENT, events: [event(s), event(t)] })).rejects.toBeInstanceOf(ResultRenderNotFoundError);
      await expect(renders.record(s.tenant, s.reader, { sentAt: SENT, events: [event(s), event(s, { resultId: randomUUID() })] })).rejects.toBeInstanceOf(
        ResultRenderNotFoundError,
      );
      expect(await count(s.tenant)).toBe(0);
      expect(await count(t.tenant)).toBe(0);
    });

    it('skips and counts a duration whose exposure is not stored, and stores the rest of the batch', async () => {
      const s = await evaluated();
      const orphan = event(s, { seq: 1, kind: 'duration', continuousMs: 2000, cumulativeMs: 2000 });
      expect(await renders.record(s.tenant, s.reader, { sentAt: SENT, events: [event(s), orphan] })).toEqual({ stored: 1, alreadyStored: 0, withoutExposure: 1 });
      expect(await renders.record(s.tenant, s.reader, { sentAt: SENT, events: [orphan] })).toEqual({ stored: 0, alreadyStored: 0, withoutExposure: 1 });
      expect(await count(s.tenant)).toBe(1);
    });

    it('refuses an admin with no clinical role (the trigger), and stores nothing', async () => {
      const s = await evaluated();
      await expect(renders.record(s.tenant, s.admin, { sentAt: SENT, events: [event(s)] })).rejects.toBeInstanceOf(ResultRenderNotReaderError);
      expect(await count(s.tenant)).toBe(0);
    });
  });
});
