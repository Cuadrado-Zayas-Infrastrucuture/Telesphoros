import { Client } from 'pg';
import { appendEvent, newId } from '../../src/ledger/ledger-writer';
import { captureFor, type SeededReport } from './ledger-fixtures';
import type { PgError } from './ledger-sql';

/** The barrier tooling exercises the ledger itself, not the watch: its gate never closes. */
const OPEN_GATE = { assertOpen: (): void => undefined };

/**
 * Two-session tests hold one connection at a known point and let the database's own lock queue decide the order. Nothing here sleeps
 * to "wait for the other side": `untilBlocked` polls pg_stat_activity until the named connection is queued behind a lock (bounded).
 */
const BLOCKED_MS = 5_000;

export class Session {
  private constructor(readonly client: Client, readonly name: string, readonly actor: string, readonly tenantId: string) {}

  /** A transaction as the application role, in a tenant, with an actor. */
  static async open(url: string, name: string, tenantId: string, actor = 'syn-session'): Promise<Session> {
    const client = new Client({ connectionString: url, application_name: name });
    await client.connect();
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [tenantId]);
    await client.query(`SELECT set_config('app.current_actor', $1, true)`, [actor]);
    return new Session(client, name, actor, tenantId);
  }

  /** Starts a statement without waiting for it; the outcome is read later. */
  start(sql: string, values: unknown[] = []): Promise<PgError | undefined> {
    return this.client.query(sql, values).then(() => undefined, (error: PgError) => error);
  }

  /** Inserts a capture and its ledger event, uncommitted: this session then holds the tenant's ledger lock until it commits or rolls back. */
  async insertCapture(report: SeededReport): Promise<string> {
    const input = captureFor(report);
    const id = newId();
    const eventId = newId();
    await this.client.query(
      `INSERT INTO report_captures (id, tenant_id, created_by, ledger_event_id, report_id, pdf_sha256, text_storage_key, text_sha256, text_scalars, poppler_version, runner)
       VALUES ($1, $2, $11, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [id, report.tenantId, eventId, report.reportId, input.pdfSha256, input.textStorageKey, input.textSha256, input.textScalars, input.popplerVersion, input.runner, this.actor],
    );
    await appendEvent(OPEN_GATE, report.tenantId, this.client, 'report_captures', id, eventId);
    return id;
  }

  /** Raises a dispute and its ledger event, uncommitted (it needs the same ledger lock as any other record). */
  async raiseDispute(tenantId: string): Promise<string> {
    const prepared = await this.prepareDispute(tenantId);
    await this.appendPrepared(prepared);
    return prepared.id;
  }

  /**
   * Inserts a dispute WITHOUT its ledger event. Nothing here needs the ledger lock, so a test can do this first and keep the window in which
   * it holds the lock (which the ledger bounds at 3 s) as short as possible: only `appendPrepared` waits behind it.
   */
  async prepareDispute(tenantId: string): Promise<{ id: string; eventId: string }> {
    const id = newId();
    const eventId = newId();
    const noteId = newId();
    await this.client.query(
      `INSERT INTO event_notes (id, tenant_id, created_by, body, body_sha256) VALUES ($1, $2, $3, 'a disputed cell', encode(sha256(convert_to('a disputed cell', 'UTF8')), 'hex'))`,
      [noteId, tenantId, this.actor],
    );
    await this.client.query(
      `INSERT INTO cell_disputes (id, tenant_id, created_by, ledger_event_id, guideline_id, guideline_version, guideline_content_sha256, locator_table, locator_row, locator_column, note_id)
       VALUES ($1, $2, $6, $3, 'syn-guideline', '1', $4, 'recommendations', 'poor', NULL, $5)`,
      [id, tenantId, eventId, 'c'.repeat(64), noteId, this.actor],
    );
    return { id, eventId };
  }

  appendPrepared(prepared: { id: string; eventId: string }): Promise<unknown> {
    return appendEvent(OPEN_GATE, this.tenantId, this.client, 'cell_disputes', prepared.id, prepared.eventId);
  }

  commit() {
    return this.client.query('COMMIT');
  }

  async close() {
    await this.client.query('ROLLBACK').catch(() => undefined); // intentional: the transaction may already be finished
    await this.client.end();
  }
}

/**
 * Waits (bounded) until a connection with this application name is queued behind another session's lock. This is the barrier.
 * One connection is used for all the polling: connecting afresh on every poll is slow under load and would stretch the time the
 * other session holds the ledger lock, which the ledger itself bounds at 3 s.
 */
export async function untilBlocked(adminUrl: string, applicationName: string): Promise<void> {
  const watcher = new Client({ connectionString: adminUrl });
  await watcher.connect();
  try {
    const deadline = Date.now() + BLOCKED_MS;
    while (Date.now() < deadline) {
      const blocked = await watcher.query(`SELECT 1 FROM pg_stat_activity WHERE application_name = $1 AND wait_event_type = 'Lock'`, [applicationName]);
      if (blocked.rowCount) return;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  } finally {
    await watcher.end();
  }
  throw new Error(`${applicationName} never blocked: the two sessions did not interleave as the test requires`);
}
