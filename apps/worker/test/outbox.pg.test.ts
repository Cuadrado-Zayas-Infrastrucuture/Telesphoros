import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { JobQueue } from '@telesphoros/jobs';
import { TENANT_A, TENANT_B, TENANT_SUSPENDED, createFixture, jobRow, type Fixture } from './support';

let f: Fixture;
let queue: JobQueue;
beforeAll(async () => {
  f = await createFixture();
  queue = new JobQueue(f.worker);
});
afterAll(async () => f.close());

/** The API's way: inside a transaction that binds the organization. */
async function appendAs(tenant: string | undefined, subject: string, options: { rollback?: boolean; type?: string } = {}): Promise<void> {
  const c = new Client({ connectionString: f.db.appUrl });
  await c.connect();
  try {
    await c.query('BEGIN');
    if (tenant) await c.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [tenant]);
    await c.query('SELECT outbox_append($1, $2)', [options.type ?? 'report.file-committed', subject]);
    await c.query(options.rollback ? 'ROLLBACK' : 'COMMIT');
  } catch (error) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    await c.end();
  }
}
const events = (subject: string) => f.admin.query('SELECT * FROM outbox_events WHERE subject_id = $1', [subject]).then((r) => r.rows);
const jobsFor = (subject: string) => f.admin.query(`SELECT * FROM jobs WHERE payload ->> 'reportId' = $1 ORDER BY seq`, [subject]).then((r) => r.rows);
const drain = async () => {
  for (let i = 0; i < 20 && (await queue.relayOutbox(500)) > 0; i += 1);
};

describe("writing an event (the API's side)", () => {
  it('takes the organization from the transaction; a rolled-back change leaves no event; a committed one leaves exactly one even if asked twice', async () => {
    const kept = randomUUID();
    await appendAs(TENANT_A, kept);
    await appendAs(TENANT_A, kept);
    expect(await events(kept)).toMatchObject([{ tenant_id: TENANT_A, event_type: 'report.file-committed', relayed_at: null, relay_outcome: null }]);
    const undone = randomUUID();
    await appendAs(TENANT_A, undone, { rollback: true });
    expect(await events(undone)).toEqual([]);
  });

  it('refuses an event with no organization bound, an unknown type, and every direct write or read by the application and worker logins', async () => {
    await expect(appendAs(undefined, randomUUID())).rejects.toThrow(/needs an organization/);
    await expect(appendAs(TENANT_A, randomUUID(), { type: 'report.something-else' })).rejects.toThrow(/outbox_events_type_check/);
    for (const url of [f.db.appUrl, f.db.workerUrl]) {
      const c = new Client({ connectionString: url });
      await c.connect();
      try {
        for (const sql of [
          `SELECT * FROM outbox_events`,
          `INSERT INTO outbox_events (tenant_id, event_type, subject_id) VALUES ('${TENANT_A}', 'report.file-committed', gen_random_uuid())`,
          `UPDATE outbox_events SET relayed_at = now()`,
          `DELETE FROM outbox_events`,
          `SELECT * FROM outbox_routes`,
        ]) {
          await expect(c.query(sql), sql).rejects.toThrow(/permission denied/);
        }
      } finally {
        await c.end();
      }
    }
    // The worker cannot forge an event, and the application cannot run the relay.
    const w = new Client({ connectionString: f.db.workerUrl });
    const a = new Client({ connectionString: f.db.appUrl });
    await Promise.all([w.connect(), a.connect()]);
    try {
      await expect(w.query(`SELECT outbox_append('report.file-committed', gen_random_uuid())`)).rejects.toThrow(/permission denied/);
      await expect(a.query('SELECT outbox_relay(10)')).rejects.toThrow(/permission denied/);
    } finally {
      await Promise.all([w.end(), a.end()]);
    }
  });

  it('keeps the record: an event cannot be edited, deleted or truncated even by the owner, and is decided once', async () => {
    const subject = randomUUID();
    await appendAs(TENANT_A, subject);
    await expect(f.admin.query(`UPDATE outbox_events SET subject_id = gen_random_uuid() WHERE subject_id = $1`, [subject])).rejects.toThrow(/changes only by being relayed/);
    await expect(f.admin.query(`UPDATE outbox_events SET tenant_id = 'x' WHERE subject_id = $1`, [subject])).rejects.toThrow(/changes only by being relayed/);
    await expect(f.admin.query(`DELETE FROM outbox_events WHERE subject_id = $1`, [subject])).rejects.toThrow(/append-only/);
    await expect(f.admin.query('TRUNCATE outbox_events')).rejects.toThrow();
    await queue.relayOutbox(500);
    await expect(f.admin.query(`UPDATE outbox_events SET relay_outcome = 'no-route' WHERE subject_id = $1`, [subject])).rejects.toThrow(/does not change/);
  });
});

describe('a poisoned event', () => {
  // An event the relay cannot turn into a job (here: a trigger on jobs refuses one organization's job), standing in for whatever might make one event fail.
  const POISON = 'worker-test-poison';
  beforeAll(async () => {
    await f.admin.query(`INSERT INTO tenants (id, display_name, status, created_by, changed_by) VALUES ($1, $1, 'active', 'worker-test', 'worker-test')`, [POISON]);
  });
  const poison = async () => {
    await f.admin.query(
      `CREATE FUNCTION syn_poison_job() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.tenant_id = '${POISON}' THEN RAISE EXCEPTION 'synthetic poison' USING ERRCODE = 'check_violation'; END IF; RETURN NEW; END $$`,
    );
    await f.admin.query('CREATE TRIGGER syn_poison BEFORE INSERT ON jobs FOR EACH ROW EXECUTE FUNCTION syn_poison_job()');
  };
  const heal = async () => {
    await f.admin.query('DROP TRIGGER IF EXISTS syn_poison ON jobs');
    await f.admin.query('DROP FUNCTION IF EXISTS syn_poison_job()');
  };

  it('does not stop the events behind it, stays pending, and is relayed once whatever refused it is gone', async () => {
    const [bad, goodA, goodB] = [randomUUID(), randomUUID(), randomUUID()];
    await poison();
    try {
      await appendAs(POISON, bad); // the earliest pending event
      await appendAs(TENANT_A, goodA);
      await appendAs(TENANT_B, goodB);
      await drain(); // before the fix this throws on the first call and every later one: the earliest event is picked again each time
      for (const s of [goodA, goodB]) {
        expect((await events(s))[0], s).toMatchObject({ relay_outcome: 'relayed' });
        expect(await jobsFor(s), s).toHaveLength(1);
      }
      expect((await events(bad))[0]).toMatchObject({ relayed_at: null, relay_outcome: null }); // not lost, not marked: it is still pending
      expect(await jobsFor(bad)).toEqual([]);
      expect(await queue.relayOutbox(500)).toBe(0); // with only the poisoned event left the call returns, it does not raise
      // It is quiet in the log (the call returned), so the statistics are how it shows: one pending event, and it has been waiting.
      const waiting = await queue.outboxStats();
      expect(waiting.pending).toBe(1);
      expect(waiting.oldestPendingSeconds).toBeGreaterThan(0);
    } finally {
      await heal();
    }
    await drain(); // whatever refused it is gone
    expect((await events(bad))[0]).toMatchObject({ relay_outcome: 'relayed' });
    expect(await jobsFor(bad)).toHaveLength(1);
    expect(await queue.outboxStats()).toEqual({ pending: 0, oldestPendingSeconds: null });
  });

  it('control: events of a healthy organization are relayed as before when nothing is poisoned', async () => {
    const subject = randomUUID();
    await appendAs(TENANT_A, subject);
    await drain();
    expect((await events(subject))[0]).toMatchObject({ relay_outcome: 'relayed' });
  });
});

describe('the relay', () => {
  it('turns each event into one job for its organization, named by the event, with a flat payload, and marks it', async () => {
    const subject = randomUUID();
    await appendAs(TENANT_A, subject);
    await drain();
    const [event] = await events(subject);
    expect(event).toMatchObject({ relay_outcome: 'relayed', relayed_at: expect.any(Date) });
    const jobs = await jobsFor(subject);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      tenant_id: TENANT_A,
      type: 'files.verify-stored',
      payload: { reportId: subject },
      idempotency_key: `outbox-${event.id}`,
      requested_by: 'system:outbox',
      state: 'queued',
      max_attempts: 5,
    });
    expect(await queue.relayOutbox(500)).toBe(0); // nothing left to do
    expect(await jobsFor(subject)).toHaveLength(1);
  });

  it('never creates a job twice, however many relays run at once or how often', async () => {
    const subjects = Array.from({ length: 30 }, () => randomUUID());
    for (const [i, s] of subjects.entries()) await appendAs(i % 2 ? TENANT_A : TENANT_B, s);
    const counts = await Promise.all(Array.from({ length: 6 }, () => queue.relayOutbox(7)));
    await drain();
    expect(counts.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(30);
    for (const s of subjects) {
      expect(await jobsFor(s), s).toHaveLength(1);
      expect((await events(s))[0].relay_outcome).toBe('relayed');
    }
  });

  it('marks an event for an organization that is not registered (a disposable local run) and creates nothing', async () => {
    const subject = randomUUID();
    await appendAs('unregistered-local-run', subject);
    await drain();
    expect((await events(subject))[0]).toMatchObject({ relay_outcome: 'no-organization' });
    expect(await jobsFor(subject)).toEqual([]);
  });

  it('marks an event with no route and keeps the rest of the batch going', async () => {
    const subject = randomUUID();
    await appendAs(TENANT_A, subject);
    await f.admin.query(`DELETE FROM outbox_routes WHERE event_type = 'report.file-committed'`);
    try {
      await drain();
      expect((await events(subject))[0]).toMatchObject({ relay_outcome: 'no-route' });
      expect(await jobsFor(subject)).toEqual([]);
    } finally {
      await f.admin.query(`INSERT INTO outbox_routes (event_type, job_type, subject_key, max_attempts) VALUES ('report.file-committed', 'files.verify-stored', 'reportId', 5)`);
    }
  });

  it('still makes the job for a suspended organization; the claim holds it until the organization is active again', async () => {
    const subject = randomUUID();
    await f.admin.query(`UPDATE tenants SET status = 'active' WHERE id = $1`, [TENANT_SUSPENDED]);
    await appendAs(TENANT_SUSPENDED, subject);
    await f.admin.query(`UPDATE tenants SET status = 'suspended' WHERE id = $1`, [TENANT_SUSPENDED]);
    await drain();
    const [job] = await jobsFor(subject);
    expect(job).toMatchObject({ tenant_id: TENANT_SUSPENDED, state: 'queued' });
    expect(await queue.claim('w', { types: ['files.verify-stored'], batch: 50, tenantCap: 50, leaseSeconds: 30 })).not.toContainEqual(expect.objectContaining({ id: job.id }));
    expect((await jobRow(f.admin, job.id)).state).toBe('queued');
    await f.admin.query(`UPDATE tenants SET status = 'active' WHERE id = $1`, [TENANT_SUSPENDED]);
    try {
      const claimed = await queue.claim('w', { types: ['files.verify-stored'], batch: 50, tenantCap: 50, leaseSeconds: 30 });
      expect(claimed.map((j) => j.id)).toContain(job.id);
    } finally {
      await f.admin.query(`UPDATE tenants SET status = 'suspended' WHERE id = $1`, [TENANT_SUSPENDED]);
    }
  });

  it('is atomic: when the job cannot be made, the relay does not raise, the event stays pending with no job, and the next relay makes exactly one job', async () => {
    const subject = randomUUID();
    await appendAs(TENANT_A, subject);
    await drain(); // anything else pending goes first
    const other = randomUUID();
    await appendAs(TENANT_A, other);
    await f.admin.query(`ALTER TABLE jobs ADD CONSTRAINT zz_block CHECK (type <> 'files.verify-stored') NOT VALID`);
    try {
      expect(await queue.relayOutbox(500)).toBe(0); // before migration 0036 this raised and halted every organization's relay; now only this event waits
      expect((await events(other))[0]).toMatchObject({ relayed_at: null, relay_outcome: null });
      expect(await jobsFor(other)).toEqual([]);
    } finally {
      await f.admin.query(`ALTER TABLE jobs DROP CONSTRAINT zz_block`);
    }
    await drain();
    expect(await jobsFor(other)).toHaveLength(1);
    expect((await events(other))[0].relay_outcome).toBe('relayed');
  });
});
