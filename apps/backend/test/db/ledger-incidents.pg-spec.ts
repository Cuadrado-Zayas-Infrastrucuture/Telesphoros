import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { Database } from '../../src/db/database';
import { LedgerCompromisedError } from '../../src/ledger/ledger-types';
import { LedgerVerifier } from '../../src/ledger/verifier';
import { PostgresLedgerRecordsRepository } from '../../src/storage/postgres/ledger-records.repository';
import { Session, untilBlocked } from '../helpers/barrier';
import { createEphemeralDatabase, type EphemeralDatabase, withAdmin } from '../helpers/database';
import { acceptanceFor, captureFor, seedLabReport } from '../helpers/ledger-fixtures';
import { attempt, type PgError, uuid } from '../helpers/ledger-sql';

// Shared ledger containment (migration 0011, FD-2) against a REAL database: what each login may call, what `ledger_append` refuses and
// when, the rules for clearing an incident, and the order of an in-flight write and a new incident. Synthetic data only.

let pg: EphemeralDatabase;
let database: Database;
let repo: PostgresLedgerRecordsRepository;
let verifier: LedgerVerifier;

beforeAll(async () => {
  pg = await createEphemeralDatabase();
  database = new Database({ url: pg.appUrl, ssl: 'disable' });
  repo = new PostgresLedgerRecordsRepository(database);
  verifier = LedgerVerifier.connect(pg.verifierUrl);
}, 60_000);
afterAll(async () => {
  await verifier.close();
  await database.onModuleDestroy();
  await pg.drop();
});

/** A tenant with a capture and an accepted capture (two events, one note). */
async function tenant(): Promise<{ tenantId: string; head: number }> {
  const tenantId = `tenant-${randomUUID()}`;
  const report = await seedLabReport(pg.adminUrl, tenantId);
  const capture = captureFor(report);
  const c = await repo.insertCapture(tenantId, report.uploader, capture);
  await repo.insertAcceptance(tenantId, 'syn-reviewer', acceptanceFor(c.record.id, capture, { note: 'checked against the page' }));
  return { tenantId, head: await headOf(tenantId) };
}
const headOf = (tenantId: string) => withAdmin(pg.adminUrl, async (c) => Number((await c.query(`SELECT seq FROM ledger_heads WHERE tenant_id = $1`, [tenantId])).rows[0].seq));
const eventCount = (tenantId: string) => withAdmin(pg.adminUrl, async (c) => Number((await c.query(`SELECT count(*) AS n FROM ledger_events WHERE tenant_id = $1`, [tenantId])).rows[0].n));
const q = <T = Record<string, unknown>>(sql: string, values: unknown[] = []) => withAdmin(pg.adminUrl, async (c) => (await c.query(sql, values)).rows as T[]);

/** A login's own connection, for the calls only it may make. */
async function as<T>(url: string, work: (c: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
}
const fail = async (work: Promise<unknown>): Promise<PgError> => {
  try {
    await work;
  } catch (error) {
    return error as PgError;
  }
  throw new Error('expected the call to be refused');
};
const record = (tenantId: string, kind = 'payload-mismatch', seq: number | null = 1, source = 'background') =>
  as(pg.verifierUrl, async (c) => (await c.query(`SELECT ledger_record_incident($1, $2, $3::bigint, $4)::text AS id`, [tenantId, kind, seq, source])).rows[0].id as string);
const hold = (basis = 'investigating a report from the founder') => as(pg.operatorUrl, async (c) => (await c.query(`SELECT ledger_set_global_hold($1)::text AS id`, [basis])).rows[0].id as string);
const clear = (incident: string, basis = 'chain verified again after repair') => as(pg.operatorUrl, async (c) => (await c.query(`SELECT ledger_clear_incident($1::uuid, $2)::text AS id`, [incident, basis])).rows[0].id as string);
const openIds = () => q<{ id: string }>(`SELECT id::text AS id FROM ledger_incidents i WHERE NOT EXISTS (SELECT 1 FROM ledger_incident_clearances c WHERE c.incident_id = i.id)`).then((r) => r.map((x) => x.id));
/** Clears whatever is open, with the evidence the rules demand (a full walk that begins now), so a test starts from a clean state. */
async function reset(): Promise<void> {
  for (const id of await openIds()) {
    const row = (await q<{ scope: string; tenant_id: string | null }>(`SELECT scope, tenant_id FROM ledger_incidents WHERE id = $1`, [id]))[0]!;
    if (row.scope === 'tenant') await verifier.verify(row.tenant_id!, { mode: 'full', recordCheckpoint: true });
    await clear(id, 'test reset');
  }
}
/** A write through the application role. Resolves when it was stored; rejects with what the application would see. */
const write = async (tenantId: string) => {
  const report = await seedLabReport(pg.adminUrl, tenantId);
  return repo.insertCapture(tenantId, report.uploader, captureFor(report));
};

describe('who may call what', () => {
  const FUNCTIONS = {
    ledger_append: '(uuid, text, text, uuid, text, smallint)',
    ledger_append_internal: '(uuid, text, text, uuid, text, smallint)',
    ledger_record_checkpoint4: '(text, bigint, text, text)',
    ledger_record_checkpoint5: '(text, bigint, text, text, timestamptz)',
    ledger_record_incident: '(text, text, bigint, text)',
    ledger_set_global_hold: '(text)',
    ledger_clear_incident: '(uuid, text)',
  } as const;
  const signature = (key: keyof typeof FUNCTIONS) => `${key.replace(/[45]$/, '')}${FUNCTIONS[key]}`;
  const may = async (role: string, key: keyof typeof FUNCTIONS) =>
    (await q<{ ok: boolean }>(`SELECT has_function_privilege($1, $2::regprocedure, 'EXECUTE') AS ok`, [role, signature(key)]))[0]!.ok;

  it('the application role calls the gate and nothing behind it (ledger_append_internal in particular)', async () => {
    const allowed: Array<keyof typeof FUNCTIONS> = ['ledger_append'];
    for (const key of Object.keys(FUNCTIONS) as Array<keyof typeof FUNCTIONS>) expect([key, await may('telesphoros_app', key)]).toEqual([key, allowed.includes(key)]);
  });

  it('the verifier records checkpoints and tenant incidents only; the operator holds and clears only; nobody else, and PUBLIC nothing', async () => {
    const matrix: Record<string, Array<keyof typeof FUNCTIONS>> = {
      telesphoros_ledger_verifier: ['ledger_record_checkpoint4', 'ledger_record_checkpoint5', 'ledger_record_incident'],
      telesphoros_ledger_operator: ['ledger_set_global_hold', 'ledger_clear_incident'],
    };
    for (const [role, allowed] of Object.entries(matrix)) {
      for (const key of Object.keys(FUNCTIONS) as Array<keyof typeof FUNCTIONS>) expect([role, key, await may(role, key)]).toEqual([role, key, allowed.includes(key)]);
    }
    const publicExecute = await q<{ proname: string }>(`
      SELECT p.proname FROM pg_proc p, LATERAL aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
       WHERE p.pronamespace = 'public'::regnamespace AND a.grantee = 0 AND a.privilege_type = 'EXECUTE' AND p.proname LIKE 'ledger\\_%'`);
    expect(publicExecute).toEqual([]);
  });

  it('only the verifier and the operator can read the incident tables; the application role cannot, and nobody can change them', async () => {
    for (const table of ['ledger_incidents', 'ledger_incident_clearances']) {
      await as(pg.verifierUrl, (c) => c.query(`SELECT count(*) FROM ${table}`));
      await as(pg.operatorUrl, (c) => c.query(`SELECT count(*) FROM ${table}`));
      expect((await fail(as(pg.appUrl, (c) => c.query(`SELECT count(*) FROM ${table}`)))).code).toBe('42501');
      for (const url of [pg.appUrl, pg.verifierUrl, pg.operatorUrl]) {
        for (const sql of [`DELETE FROM ${table}`, `UPDATE ${table} SET basis = 'x'`, `TRUNCATE ${table}`, `INSERT INTO ${table} DEFAULT VALUES`]) {
          expect([table, sql, (await fail(as(url, (c) => c.query(sql)))).code]).toEqual([table, sql, '42501']);
        }
      }
    }
  });

  it('even the table owner and a superuser cannot update, delete or truncate a row (the append-only trigger)', async () => {
    const { tenantId } = await tenant();
    const id = await record(tenantId);
    await verifier.verify(tenantId, { mode: 'full', recordCheckpoint: true });
    await clear(id); // so that a clearance row exists to try the same on
    const expected: Array<[string, string]> = [
      [`UPDATE ledger_incidents SET kind = 'seq-gap' WHERE id = '${id}'`, '23000'],
      [`DELETE FROM ledger_incidents WHERE id = '${id}'`, '23000'],
      [`UPDATE ledger_incident_clearances SET basis = 'x' WHERE incident_id = '${id}'`, '23000'],
      [`DELETE FROM ledger_incident_clearances WHERE incident_id = '${id}'`, '23000'],
      ['TRUNCATE ledger_incident_clearances', '23000'],
      // (The incidents table is also referenced by a foreign key, which refuses a TRUNCATE before the trigger would.)
      ['TRUNCATE ledger_incidents', '0A000'],
    ];
    for (const [sql, code] of expected) {
      const error = await fail(withAdmin(pg.adminUrl, (c) => c.query(sql)));
      expect([sql, error.code]).toEqual([sql, code]);
    }
    expect(await q(`SELECT 1 FROM ledger_incidents WHERE id = $1`, [id])).toHaveLength(1);
  });
});

describe('what ledger_append refuses, and when', () => {
  it('refuses the contained tenant inside the database (SQLSTATE LC001) and stores nothing; another tenant is not affected', async () => {
    const a = await tenant();
    const b = await tenant();
    await record(a.tenantId);
    const before = await eventCount(a.tenantId);
    const captures = async () => Number((await q<{ n: string }>(`SELECT count(*) AS n FROM report_captures WHERE tenant_id = $1`, [a.tenantId]))[0]!.n);
    const capturesBefore = await captures();
    // The application sees LedgerCompromisedError, from the DATABASE: this repository's own gate is open.
    await expect(write(a.tenantId)).rejects.toBeInstanceOf(LedgerCompromisedError);
    expect(await eventCount(a.tenantId)).toBe(before);
    expect(await captures()).toBe(capturesBefore); // the capture row rolled back with it
    // The raw code, for the record.
    const error = await attempt(pg.appUrl, a.tenantId, 'syn-x', (c) => c.query(`SELECT ledger_append($1::uuid, 'capture', 'report_captures', $2::uuid, $3, 1::smallint)`, [uuid(), uuid(), 'a'.repeat(64)]));
    expect(error?.code).toBe('LC001');
    await expect(write(b.tenantId)).resolves.toBeDefined(); // control: the same call works for a tenant without an incident
    await reset();
    await expect(write(a.tenantId)).resolves.toBeDefined(); // control: and for this tenant once the incident is cleared
  });

  it('recording is idempotent while an incident is open (the first finding is kept), and a cleared tenant can be contained again', async () => {
    const { tenantId } = await tenant();
    const first = await record(tenantId, 'seq-gap', 2, 'startup');
    expect(await record(tenantId, 'head-mismatch', 5, 'scheduled')).toBe(first);
    expect(await q(`SELECT kind, failed_seq::int AS seq, source FROM ledger_incidents WHERE id = $1`, [first])).toEqual([{ kind: 'seq-gap', seq: 2, source: 'startup' }]);
    await reset();
    expect(await record(tenantId)).not.toBe(first);
    await reset();
  });

  it('a tenant without a ledger cannot be contained, the source "manual" is not a verification, and bad values are refused', async () => {
    expect((await fail(record(`tenant-${randomUUID()}`))).code).toBe('P0002');
    const { tenantId } = await tenant();
    expect((await fail(record(tenantId, 'payload-mismatch', 1, 'manual'))).code).toBe('42501');
    expect((await fail(record(tenantId, 'Not A Kind'))).code).toBe('23514');
    expect((await fail(record(tenantId, 'payload-mismatch', 1, 'somewhere'))).code).toBe('23514');
    expect((await fail(record(''))).code).toBe('22023');
    expect(await openIds()).toEqual([]);
  });

  it('checkpoints and redactions still work during an incident: the verifier can record what it found, an operator can still remove PHI', async () => {
    const { tenantId } = await tenant();
    await record(tenantId);
    const walked = await verifier.verify(tenantId, { mode: 'full', recordCheckpoint: true });
    expect(walked).toMatchObject({ status: 'ok', checkpointId: expect.any(String) });
    const note = (await q<{ id: string }>(`SELECT id::text AS id FROM event_notes WHERE tenant_id = $1 AND redacted_at IS NULL LIMIT 1`, [tenantId]))[0]!;
    expect(await attempt(pg.operatorUrl, tenantId, 'operator-1', (c) => c.query(`SELECT redact_event_note($1, $2, 'phi-in-note')`, [note.id, uuid()]))).toBeUndefined();
    await reset();
  });
});

describe('a global hold', () => {
  it('refuses every tenant until a person lifts it; it is idempotent, needs a basis, and is not something the verifier or the application can do', async () => {
    const a = await tenant();
    const b = await tenant();
    const id = await hold();
    expect(await hold('a second request while the first is open')).toBe(id);
    expect((await fail(hold(''))).code).toBe('22023');
    expect((await fail(hold('x'.repeat(501)))).code).toBe('22023');
    for (const url of [pg.verifierUrl, pg.appUrl]) expect((await fail(as(url, (c) => c.query(`SELECT ledger_set_global_hold('not allowed')`)))).code).toBe('42501');

    await expect(write(a.tenantId)).rejects.toBeInstanceOf(LedgerCompromisedError);
    await expect(write(b.tenantId)).rejects.toBeInstanceOf(LedgerCompromisedError);
    expect(await q(`SELECT scope, tenant_id, kind, source, recorded_by FROM ledger_incidents WHERE id = $1`, [id])).toEqual([
      { scope: 'global', tenant_id: null, kind: 'manual-hold', source: 'manual', recorded_by: 'telesphoros_test_operator' },
    ]);

    await clear(id, 'the investigation found nothing; resuming'); // a global hold needs a decision, not a checkpoint
    await expect(write(a.tenantId)).resolves.toBeDefined();
    await expect(write(b.tenantId)).resolves.toBeDefined();
  });
});

describe('clearing an incident', () => {
  it('is refused without a full verification that began after the incident, and only the operator can ask', async () => {
    const { tenantId } = await tenant();
    await verifier.verify(tenantId, { mode: 'full', recordCheckpoint: true }); // evidence from BEFORE the incident
    const id = await record(tenantId);
    expect((await fail(clear(id))).code).toBe('23000');
    for (const url of [pg.verifierUrl, pg.appUrl]) expect((await fail(as(url, (c) => c.query(`SELECT ledger_clear_incident($1::uuid, 'no')`, [id])))).code).toBe('42501');
    expect(await openIds()).toContain(id);
    await reset();
  });

  it('accepts a full verification that began after the incident, and records who cleared it, on what basis and on which checkpoint', async () => {
    const { tenantId } = await tenant();
    const id = await record(tenantId);
    const walked = await verifier.verify(tenantId, { mode: 'full', recordCheckpoint: true });
    expect(walked.checkpointId).toEqual(expect.any(String));
    const cleared = await clear(id, 'repaired from the nightly backup');
    expect(await q(`SELECT incident_id::text AS incident, cleared_by, basis, verified_checkpoint_id::text AS checkpoint FROM ledger_incident_clearances WHERE id = $1`, [cleared])).toEqual([
      { incident: id, cleared_by: 'telesphoros_test_operator', basis: 'repaired from the nightly backup', checkpoint: walked.checkpointId },
    ]);
    expect((await fail(clear(id))).code).toBe('23000'); // once only
    expect((await fail(clear(uuid()))).code).toBe('P0002');
    expect((await fail(clear(id, ''))).code).toBe('22023');
  });

  it('RACE: a walk that STARTED before the incident was recorded does not qualify, even though it finished after (the walk-start rule)', async () => {
    const { tenantId } = await tenant();
    // A walk begins (its start time is the database clock at the start of its snapshot)...
    const started = await as(pg.verifierUrl, async (c) => {
      await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const t = (await c.query<{ at: string }>(`SELECT now()::text AS at`)).rows[0]!.at;
      await c.query('COMMIT');
      return t;
    });
    // ...another walk finds damage and the incident is recorded...
    const id = await record(tenantId);
    // ...and the first walk finishes OK and records its checkpoint afterwards.
    const head = (await q<{ seq: string; record_hash: string }>(`SELECT seq::text, record_hash FROM ledger_heads WHERE tenant_id = $1`, [tenantId]))[0]!;
    await as(pg.verifierUrl, (c) => c.query(`SELECT ledger_record_checkpoint($1, $2::bigint, $3, 'full', $4::timestamptz)`, [tenantId, head.seq, head.record_hash, started]));
    expect(await q(`SELECT 1 FROM ledger_checkpoints WHERE tenant_id = $1 AND mode = 'full' AND walk_started_at = $2::timestamptz`, [tenantId, started])).toHaveLength(1); // control: it exists
    const refusal = await fail(clear(id));
    expect(refusal.code).toBe('23000');
    expect(refusal.message).toMatch(/started after the incident/);
    // Control: a walk that begins after the incident does qualify.
    await verifier.verify(tenantId, { mode: 'full', recordCheckpoint: true });
    await clear(id);
  });

  it('RACE, end to end: the real verifier\'s walk is running when the incident is recorded and finishes OK afterwards; its checkpoint does not clear the incident', async () => {
    const { tenantId } = await tenant();
    // A verifier whose walk can be held at its COMMIT: the snapshot (and the walk's start time) are behind it, the checkpoint call still ahead.
    const inner = verifier as unknown as { pool: { connect: () => Promise<{ query: (...args: unknown[]) => Promise<unknown>; release: () => void }>; query: (...args: unknown[]) => Promise<unknown> } };
    let reached!: () => void;
    let release!: () => void;
    const atCommit = new Promise<void>((resolve) => { reached = resolve; });
    const held = new Promise<void>((resolve) => { release = resolve; });
    const slow = new LedgerVerifier({
      connect: async () => {
        const client = await inner.pool.connect();
        return {
          query: async (sql: unknown, ...rest: unknown[]) => {
            if (sql === 'COMMIT') {
              reached();
              await held;
            }
            return client.query(sql, ...rest);
          },
          release: () => client.release(),
        };
      },
      query: (sql: unknown, ...rest: unknown[]) => inner.pool.query(sql, ...rest),
    } as never);
    const running = slow.verify(tenantId, { mode: 'full', recordCheckpoint: true });
    await atCommit; // the walk has read the whole chain and found nothing; it has not yet finished, and has not written its checkpoint
    const id = await record(tenantId); // another walk found damage and recorded it in the meantime
    release();
    const result = await running;
    expect(result).toMatchObject({ status: 'ok', checkpointId: expect.any(String) }); // control: it did write a checkpoint, a good one
    const refusal = await fail(clear(id));
    expect(refusal.code).toBe('23000');
    expect(refusal.message).toMatch(/started after the incident/);
    await verifier.verify(tenantId, { mode: 'full', recordCheckpoint: true }); // control: a walk that begins after the incident clears it
    await clear(id);
  });

  it('does not accept a tail checkpoint, a checkpoint from the older four-argument function (rolling upgrade), another tenant\'s checkpoint, or one that stops short of the failed sequence', async () => {
    const a = await tenant();
    const b = await tenant();
    const id = await record(a.tenantId, 'payload-mismatch', a.head); // the failure is at the current head
    const at = async (seq: number) => (await q<{ seq: string; record_hash: string }>(`SELECT seq::text, record_hash FROM ledger_events WHERE tenant_id = $1 AND seq = $2`, [a.tenantId, seq]))[0]!;
    const headA = await at(await headOf(a.tenantId));

    // An older task's four-argument call: it works for its own purpose and carries no walk start.
    await as(pg.verifierUrl, (c) => c.query(`SELECT ledger_record_checkpoint($1, $2::bigint, $3, 'full')`, [a.tenantId, headA.seq, headA.record_hash]));
    expect((await fail(clear(id))).code).toBe('23000');
    // A tail checkpoint with a proper start time.
    const current = await at(await headOf(a.tenantId));
    await as(pg.verifierUrl, (c) => c.query(`SELECT ledger_record_checkpoint($1, $2::bigint, $3, 'tail', now())`, [a.tenantId, current.seq, current.record_hash]));
    expect((await fail(clear(id))).code).toBe('23000');
    // A full checkpoint that stops short of the failed sequence number.
    const early = await at(1);
    await as(pg.verifierUrl, (c) => c.query(`SELECT ledger_record_checkpoint($1, $2::bigint, $3, 'full', now())`, [a.tenantId, early.seq, early.record_hash]));
    expect((await fail(clear(id))).code).toBe('23000');
    // Another tenant's full walk, later.
    await verifier.verify(b.tenantId, { mode: 'full', recordCheckpoint: true });
    expect((await fail(clear(id))).code).toBe('23000');

    // Control: this tenant's own full walk, which begins after the incident and reaches the failed sequence, clears it.
    await verifier.verify(a.tenantId, { mode: 'full', recordCheckpoint: true });
    await clear(id);
  });

  it('a start time in the future, or none, is refused by the function that writes the evidence', async () => {
    const { tenantId } = await tenant();
    const head = (await q<{ seq: string; record_hash: string }>(`SELECT seq::text, record_hash FROM ledger_heads WHERE tenant_id = $1`, [tenantId]))[0]!;
    const call = (start: string | null) => as(pg.verifierUrl, (c) => c.query(`SELECT ledger_record_checkpoint($1, $2::bigint, $3, 'full', $4::timestamptz)`, [tenantId, head.seq, head.record_hash, start]));
    expect((await fail(call(null))).code).toBe('22023');
    expect((await fail(call(new Date(Date.now() + 3_600_000).toISOString()))).code).toBe('22023');
    await call(new Date(Date.now() - 1_000).toISOString()); // control
  });

  it('a chain that is STILL damaged cannot be cleared by anyone: a failed walk writes no checkpoint', async () => {
    const { tenantId } = await tenant();
    await withAdmin(pg.adminUrl, async (c) => {
      await c.query(`SET session_replication_role = replica`);
      await c.query(`UPDATE report_captures SET text_scalars = text_scalars + 1 WHERE tenant_id = $1`, [tenantId]);
    });
    const found = await verifier.verify(tenantId, { mode: 'full', recordCheckpoint: true });
    expect(found).toMatchObject({ status: 'failed', checkpointId: null });
    const id = await record(tenantId, found.failures[0]!.kind, Number(found.failures[0]!.seq));
    const again = await verifier.verify(tenantId, { mode: 'full', recordCheckpoint: true });
    expect(again).toMatchObject({ status: 'failed', checkpointId: null });
    expect((await fail(clear(id))).code).toBe('23000');
    // Repaired: now it can be.
    await withAdmin(pg.adminUrl, async (c) => {
      await c.query(`SET session_replication_role = replica`);
      await c.query(`UPDATE report_captures SET text_scalars = text_scalars - 1 WHERE tenant_id = $1`, [tenantId]);
    });
    expect(await verifier.verify(tenantId, { mode: 'full', recordCheckpoint: true })).toMatchObject({ status: 'ok' });
    await clear(id, 'text restored from the backup');
  });
});

describe('an in-flight write and a new incident never interleave', () => {
  async function headLock(tenantId: string): Promise<Client> {
    const holder = new Client({ connectionString: pg.adminUrl });
    await holder.connect();
    await holder.query('BEGIN');
    await holder.query(`SELECT 1 FROM ledger_heads WHERE tenant_id = $1 FOR UPDATE`, [tenantId]);
    return holder;
  }
  const recordOn = async (tenantId: string, name: string) => {
    const client = new Client({ connectionString: pg.verifierUrl, application_name: name });
    await client.connect();
    const done = client.query(`SELECT ledger_record_incident($1, 'payload-mismatch', 1::bigint, 'background')::text AS id`, [tenantId]).then((r) => r.rows[0].id as string).finally(() => client.end());
    return done;
  };

  it('a write already in flight finishes first: the incident waits for its lock, and every later write is refused', async () => {
    const { tenantId } = await tenant();
    const report = await seedLabReport(pg.adminUrl, tenantId);
    const writer = await Session.open(pg.appUrl, 'inflight-writer', tenantId);
    try {
      await writer.insertCapture(report); // holds the tenant's ledger lock, uncommitted
      const incident = recordOn(tenantId, 'incident-recorder');
      await untilBlocked(pg.adminUrl, 'incident-recorder'); // the recorder is queued behind the writer
      expect(await openIds()).toEqual([]); // nothing recorded yet: the writer is still ahead of it
      const before = await eventCount(tenantId);
      await writer.commit();
      const id = await incident;
      expect(await eventCount(tenantId)).toBe(before + 1); // the in-flight write committed...
      expect(await openIds()).toEqual([id]); // ...and only then the incident
    } finally {
      await writer.close();
    }
    await expect(write(tenantId)).rejects.toBeInstanceOf(LedgerCompromisedError);
    await reset();
  });

  it('a write queued BEHIND the incident\'s lock is refused when it gets the lock, and stores nothing', async () => {
    const { tenantId } = await tenant();
    const report = await seedLabReport(pg.adminUrl, tenantId);
    const holder = await headLock(tenantId);
    const writer = await Session.open(pg.appUrl, 'queued-writer', tenantId);
    try {
      const incident = recordOn(tenantId, 'first-in-line'); // queued first
      await untilBlocked(pg.adminUrl, 'first-in-line');
      const writing = writer.insertCapture(report).then(() => undefined, (error: unknown) => error); // queued second
      await untilBlocked(pg.adminUrl, 'queued-writer');
      const before = await eventCount(tenantId);
      await holder.query('ROLLBACK'); // lets the queue run in order
      await incident;
      expect(await writing).toBeInstanceOf(LedgerCompromisedError);
      expect(await eventCount(tenantId)).toBe(before);
    } finally {
      await holder.end();
      await writer.close();
    }
    await reset();
  });

  it('control: the same queue with the WRITER first stores the write (so the refusal above is the incident, not the queue)', async () => {
    const { tenantId } = await tenant();
    const report = await seedLabReport(pg.adminUrl, tenantId);
    const holder = await headLock(tenantId);
    const writer = await Session.open(pg.appUrl, 'writer-first', tenantId);
    try {
      const writing = writer.insertCapture(report).then(() => undefined, (error: unknown) => error);
      await untilBlocked(pg.adminUrl, 'writer-first');
      const incident = recordOn(tenantId, 'recorder-second');
      await untilBlocked(pg.adminUrl, 'recorder-second');
      const before = await eventCount(tenantId);
      await holder.query('ROLLBACK');
      expect(await writing).toBeUndefined();
      await writer.commit();
      await incident;
      expect(await eventCount(tenantId)).toBe(before + 1);
    } finally {
      await holder.end();
      await writer.close();
    }
    await reset();
  });
});
