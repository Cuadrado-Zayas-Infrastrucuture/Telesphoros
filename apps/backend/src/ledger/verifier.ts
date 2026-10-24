import { createHash } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import { checkpointPayload, GENESIS_HASH, recordHash, redactionPayload } from './record-hash';
import { HASH_VERSION, PROJECTION_VERSION, RECORD_TABLES, TOMBSTONE } from './ledger-types';
import { loadProjections, projectionHash } from './projections';
import type { Compromise, OpenIncident } from './ledger-status';
import type { PassLock } from './ledger-monitor';
import { pgClientConfig } from '../db/tls';

/**
 * The ledger verifier (specification section 6.4). It connects with its OWN credentials, a login that belongs to
 * `telesphoros_ledger_verifier` and to nothing else: it reads every tenant's ledger and records (explicit read policies), and can
 * execute exactly two functions, `ledger_record_checkpoint` and `ledger_record_incident` (migration 0011). It can write no record.
 *
 * One verification runs inside ONE `REPEATABLE READ READ ONLY` transaction, so it sees a single snapshot: the head it captures,
 * the events it walks and the rows it compares all belong to the same instant. Writers are never blocked.
 *
 *   full   walks the tenant's whole chain from genesis.
 *   tail   starts from the latest checkpoint (after confirming that checkpoint still matches the chain) and walks only what came after.
 *
 * It checks BOTH directions: every event must describe a row whose projection hashes to the event's payload, and every record row
 * must be described by exactly one event. Failures are reported as a KIND and a sequence number, never a value from a record.
 * If the time or event budget runs out the result is `incomplete` (never `ok`) and no checkpoint is written.
 */
export type VerifyMode = 'full' | 'tail';
export type VerifyStatus = 'ok' | 'failed' | 'incomplete';
/** Why a walk was `incomplete`: the clock ran out, the event limit was reached, or the application was shutting down. */
export type IncompleteReason = 'time' | 'size' | 'shutdown';

export type FailureKind =
  | 'seq-gap' | 'prev-hash-mismatch' | 'record-hash-mismatch' | 'unsupported-hash-version' | 'unsupported-projection-version'
  | 'payload-mismatch' | 'record-missing' | 'record-event-mismatch' | 'row-without-event' | 'note-digest-mismatch' | 'note-redaction-invalid'
  | 'head-mismatch' | 'checkpoint-mismatch' | 'checkpoint-payload-mismatch';

export interface Failure {
  kind: FailureKind;
  /** Ledger sequence number the failure is about; null when it is about a row or note that has no event. */
  seq: string | null;
}

export interface VerifyOptions {
  mode?: VerifyMode;
  /** Wall-clock budget for the walk. Exceeding it yields `incomplete`. Default 60 s. */
  budgetMs?: number;
  /** Maximum number of events to walk. Exceeding it yields `incomplete`. Default 1,000,000. */
  maxEvents?: number;
  /** Write a checkpoint when (and only when) the verification is `ok`. */
  recordCheckpoint?: boolean;
  /**
   * With `mode: 'tail'`: a chain whose head is at or below this sequence number is walked in FULL even if a checkpoint exists. A checkpoint
   * makes a start fast; it is not an independent control (specification 6.6), so while the whole walk is cheap it is done.
   */
  fullWalkAtOrBelow?: number;
  /** Aborting stops the walk at the next batch and yields `incomplete` (never `ok`): used so a shutdown does not wait for a long walk. */
  signal?: AbortSignal;
}

export interface VerifyResult {
  tenantId: string;
  status: VerifyStatus;
  /** The mode actually used: a requested `tail` becomes `full` when the tenant has no usable checkpoint. */
  mode: VerifyMode;
  headSeq: string;
  headHash: string;
  eventsChecked: number;
  failures: Failure[];
  checkpointId: string | null;
  /** Present only when `status` is `incomplete`. `size` does not go away by waiting or retrying: the chain is longer than `maxEvents`. */
  incompleteReason?: IncompleteReason;
}

const BATCH = 200;
const MAX_FAILURES = 50;
const DEFAULT_BUDGET_MS = 60_000;
const DEFAULT_MAX_EVENTS = 1_000_000;
// Columns are qualified (`e.seq`) everywhere a text alias of the same name exists: an unqualified ORDER BY would sort the TEXT alias ("10" < "2").
const UTC = `to_char(e.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

interface EventRow {
  id: string;
  seq: string;
  event_type: string;
  subject_table: string;
  subject_id: string;
  actor_sub: string;
  payload_sha256: string;
  projection_version: number;
  hash_version: number;
  prev_hash: string;
  record_hash: string;
  created_at_utc: string;
}

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

export class LedgerVerifier {
  constructor(private readonly pool: Pool) {}

  /** A verifier on its own pool. `url` must be the verifier login, never the application's. */
  static connect(url: string, ssl: 'disable' | 'require' = 'disable'): LedgerVerifier {
    const pool = new Pool({
      ...pgClientConfig(url, ssl), max: 3, connectionTimeoutMillis: 5_000, application_name: 'telesphoros-ledger-verifier',
    });
    pool.on('error', () => undefined); // intentional: an idle verifier connection can die; the next verification opens another
    return new LedgerVerifier(pool);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  /**
   * The lock that spaces the tasks' full walks out: one session-level advisory lock for the database, taken on a connection of its own that is kept
   * for the whole walk. `undefined` when another task holds it. If this process dies the connection closes and the database frees the lock.
   */
  async acquirePassLock(): Promise<PassLock | undefined> {
    const client = await this.pool.connect();
    client.on('error', () => undefined); // intentional: a held connection that dies must not crash the process; the lock is gone with it
    try {
      const { rows } = await client.query<{ held: boolean }>(`SELECT pg_try_advisory_lock(hashtextextended('telesphoros:ledger-full-walk', 0)) AS held`);
      if (!rows[0]!.held) {
        client.release();
        return undefined;
      }
    } catch (error) {
      client.release(true);
      throw error;
    }
    return {
      release: async () => {
        try {
          await client.query(`SELECT pg_advisory_unlock(hashtextextended('telesphoros:ledger-full-walk', 0))`);
          client.release();
        } catch {
          client.release(true); // closing the connection frees the lock too
        }
      },
    };
  }

  /** Every tenant that has a ledger. */
  async tenants(): Promise<string[]> {
    const { rows } = await this.pool.query<{ tenant_id: string }>(`SELECT tenant_id FROM ledger_heads ORDER BY tenant_id`);
    return rows.map((r) => r.tenant_id);
  }

  async verify(tenantId: string, options: VerifyOptions = {}): Promise<VerifyResult> {
    const { result, startedAt } = await this.walk(tenantId, options);
    if (options.recordCheckpoint && result.status === 'ok' && result.headSeq !== '0') {
      // A separate, short, read-write transaction: the snapshot above is read-only by design. The function re-checks that the
      // head it is asked to record exists in the chain, so a head that has since moved on is still a true statement.
      // `startedAt` is the DATABASE's clock at the start of the walk's snapshot: a clearance of an incident accepts only a checkpoint whose
      // walk began after the incident was recorded, so a walk that was already running when the damage was found cannot clear it.
      const { rows } = await this.pool.query<{ id: string }>(`SELECT ledger_record_checkpoint($1, $2::bigint, $3, $4, $5::timestamptz) AS id`, [
        tenantId, result.headSeq, result.headHash, result.mode, startedAt,
      ]);
      result.checkpointId = rows[0]!.id;
    }
    return result;
  }

  /**
   * Tells the database that a verification found this tenant's record log damaged. From this call's return, `ledger_append` refuses every
   * write for the tenant in every task. Idempotent (the first finding of an open incident is kept). Returns the incident's id.
   */
  async recordIncident(finding: Pick<Compromise, 'tenantId' | 'kind' | 'seq' | 'source'>): Promise<string> {
    const { rows } = await this.pool.query<{ id: string }>(`SELECT ledger_record_incident($1, $2, $3::bigint, $4)::text AS id`, [
      finding.tenantId, finding.kind, finding.seq, finding.source,
    ]);
    return rows[0]!.id;
  }

  /** Every incident that no clearance names: tenant incidents and global holds. */
  async openIncidents(): Promise<OpenIncident[]> {
    const { rows } = await this.pool.query<{ id: string; scope: 'tenant' | 'global'; tenant_id: string | null; kind: OpenIncident['kind']; failed_seq: string | null; source: OpenIncident['source']; detected_at: Date }>(
      `SELECT i.id::text AS id, i.scope, i.tenant_id, i.kind, i.failed_seq::text AS failed_seq, i.source, i.detected_at
         FROM ledger_incidents i WHERE NOT EXISTS (SELECT 1 FROM ledger_incident_clearances c WHERE c.incident_id = i.id) ORDER BY i.seq`);
    return rows.map((r) => ({ id: r.id, scope: r.scope, tenantId: r.tenant_id, kind: r.kind, seq: r.failed_seq, source: r.source, detectedAt: r.detected_at }));
  }

  private async walk(tenantId: string, options: VerifyOptions): Promise<{ result: VerifyResult; startedAt: string }> {
    const started = Date.now();
    const budgetMs = options.budgetMs ?? DEFAULT_BUDGET_MS;
    const maxEvents = options.maxEvents ?? DEFAULT_MAX_EVENTS;
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      // The transaction's start time on the database's clock (never later than the snapshot it takes next): the conservative "walk began" instant.
      const begun = await client.query<{ at: string }>(`SELECT now()::text AS at`);
      const startedAt = begun.rows[0]!.at;
      await client.query(`SELECT set_config('statement_timeout', '30000', true)`);
      const failures: Failure[] = [];
      const fail = (kind: FailureKind, seq: string | null) => {
        if (failures.length < MAX_FAILURES) failures.push({ kind, seq });
      };

      const headRow = await client.query<{ seq: string; record_hash: string }>(`SELECT seq::text AS seq, record_hash FROM ledger_heads WHERE tenant_id = $1`, [tenantId]);
      const head = headRow.rows[0] ?? { seq: '0', record_hash: GENESIS_HASH };

      // Where to start: genesis, or the newest checkpoint if it still matches the chain.
      let mode: VerifyMode = 'full';
      let position = { seq: 0n, hash: GENESIS_HASH };
      const small = options.fullWalkAtOrBelow !== undefined && BigInt(head.seq) <= BigInt(options.fullWalkAtOrBelow);
      if (options.mode === 'tail' && !small) {
        const cp = await client.query<{ id: string; up_to_seq: string; head_hash: string; mode: string }>(
          `SELECT id::text AS id, up_to_seq::text AS up_to_seq, head_hash, mode FROM ledger_checkpoints c WHERE c.tenant_id = $1 ORDER BY c.up_to_seq DESC LIMIT 1`, [tenantId]);
        const latest = cp.rows[0];
        if (latest) {
          const at = await client.query(`SELECT 1 FROM ledger_events WHERE tenant_id = $1 AND seq = $2::bigint AND record_hash = $3`, [tenantId, latest.up_to_seq, latest.head_hash]);
          if (at.rowCount === 1) {
            mode = 'tail';
            position = { seq: BigInt(latest.up_to_seq), hash: latest.head_hash };
          } else {
            fail('checkpoint-mismatch', latest.up_to_seq);
          }
        }
      }

      let checked = 0;
      let incomplete: IncompleteReason | null = null;
      let expected = position.seq + 1n;
      let running = position.hash;
      let cursor = position.seq.toString();
      for (;;) {
        if (Date.now() - started > budgetMs || options.signal?.aborted) {
          incomplete = options.signal?.aborted ? 'shutdown' : 'time';
          break;
        }
        const batch = await client.query<EventRow>(
          `SELECT e.id::text AS id, e.seq::text AS seq, e.event_type, e.subject_table, e.subject_id::text AS subject_id, e.actor_sub, e.payload_sha256,
                  e.projection_version, e.hash_version, e.prev_hash, e.record_hash, ${UTC} AS created_at_utc
             FROM ledger_events e WHERE e.tenant_id = $1 AND e.seq > $2::bigint ORDER BY e.seq LIMIT $3`,
          [tenantId, cursor, Math.max(1, Math.min(BATCH, maxEvents - checked))],
        );
        if (batch.rows.length === 0) break;
        if (checked >= maxEvents) {
          incomplete = 'size'; // there is more chain than the budget allows: never report `ok` for a partial walk
          break;
        }
        for (const e of batch.rows) {
          if (BigInt(e.seq) !== expected) fail('seq-gap', e.seq);
          if (e.prev_hash !== running) fail('prev-hash-mismatch', e.seq);
          if (e.hash_version !== HASH_VERSION) {
            fail('unsupported-hash-version', e.seq);
          } else if (
            recordHash({
              tenantId, seq: e.seq, eventType: e.event_type, subjectTable: e.subject_table, subjectId: e.subject_id, actorSub: e.actor_sub,
              payloadSha256: e.payload_sha256, projectionVersion: e.projection_version, hashVersion: e.hash_version, prevHash: e.prev_hash, createdAtUtc: e.created_at_utc,
            }) !== e.record_hash
          ) {
            fail('record-hash-mismatch', e.seq);
          }
          if (e.projection_version !== PROJECTION_VERSION) fail('unsupported-projection-version', e.seq);
          // Re-synchronise on the stored hash so one break does not drown every later event in noise.
          running = e.record_hash;
          expected = BigInt(e.seq) + 1n;
          cursor = e.seq;
          checked += 1;
        }
        await this.checkSubjects(client, tenantId, batch.rows, fail);
        if (failures.length >= MAX_FAILURES) break;
      }

      if (!incomplete) {
        if (running !== head.record_hash || (expected - 1n).toString() !== head.seq) fail('head-mismatch', head.seq);
        await this.checkRowsHaveEvents(client, tenantId, fail);
        await this.checkNotes(client, tenantId, fail);
      }

      await client.query('COMMIT');
      const status: VerifyStatus = failures.length > 0 ? 'failed' : incomplete ? 'incomplete' : 'ok';
      const reason = status === 'incomplete' && incomplete ? { incompleteReason: incomplete } : {};
      return { result: { tenantId, status, mode, headSeq: head.seq, headHash: head.record_hash, eventsChecked: checked, failures, checkpointId: null, ...reason }, startedAt };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined); // intentional: a broken connection is released below either way
      throw error;
    } finally {
      client.release();
    }
  }

  /** Event -> row: the row exists, points back at the event, was authored by the event's actor, and its projection hashes to the payload. */
  private async checkSubjects(client: PoolClient, tenantId: string, events: EventRow[], fail: (kind: FailureKind, seq: string | null) => void): Promise<void> {
    for (const table of RECORD_TABLES) {
      const own = events.filter((e) => e.subject_table === table);
      if (own.length === 0) continue;
      const loaded = await loadProjections(client, table, own.map((e) => e.subject_id));
      for (const e of own) {
        const projection = loaded.get(e.subject_id);
        if (!projection) {
          fail('record-missing', e.seq);
          continue;
        }
        if (projection.tenantId !== tenantId || projection.ledgerEventId !== e.id || projection.createdBy !== e.actor_sub) fail('record-event-mismatch', e.seq);
        if (projectionHash(projection) !== e.payload_sha256) fail('payload-mismatch', e.seq);
      }
    }
    const checkpoints = events.filter((e) => e.subject_table === 'ledger_checkpoints');
    if (checkpoints.length > 0) {
      const { rows } = await client.query<{ id: string; tenant_id: string; up_to_seq: string; head_hash: string; mode: string; ledger_event_id: string }>(
        `SELECT id::text AS id, tenant_id, up_to_seq::text AS up_to_seq, head_hash, mode, ledger_event_id::text AS ledger_event_id FROM ledger_checkpoints WHERE id = ANY($1::uuid[])`,
        [checkpoints.map((e) => e.subject_id)],
      );
      const byId = new Map(rows.map((r) => [r.id, r]));
      for (const e of checkpoints) {
        const cp = byId.get(e.subject_id);
        if (!cp) {
          fail('record-missing', e.seq);
        } else if (cp.tenant_id !== tenantId || cp.ledger_event_id !== e.id) {
          fail('record-event-mismatch', e.seq);
        } else if (checkpointPayload({ id: cp.id, tenantId, upToSeq: cp.up_to_seq, headHash: cp.head_hash, mode: cp.mode }) !== e.payload_sha256) {
          fail('checkpoint-payload-mismatch', e.seq);
        }
      }
    }
    const redactions = events.filter((e) => e.subject_table === 'event_notes');
    if (redactions.length > 0) {
      const { rows } = await client.query<{ id: string; tenant_id: string; body: string; body_sha256: string; redacted_at: string | null; redaction_basis_code: string | null }>(
        `SELECT id::text AS id, tenant_id, body, body_sha256, redacted_at::text AS redacted_at, redaction_basis_code FROM event_notes WHERE id = ANY($1::uuid[])`,
        [redactions.map((e) => e.subject_id)],
      );
      const byId = new Map(rows.map((r) => [r.id, r]));
      for (const e of redactions) {
        const note = byId.get(e.subject_id);
        if (!note) fail('record-missing', e.seq);
        else if (note.tenant_id !== tenantId || note.redacted_at === null || note.body !== TOMBSTONE || note.redaction_basis_code === null) fail('note-redaction-invalid', e.seq);
        else if (redactionPayload({ noteId: note.id, bodySha256: note.body_sha256, basisCode: note.redaction_basis_code }) !== e.payload_sha256) fail('payload-mismatch', e.seq);
      }
    }
  }

  /** Row -> event: every record row is described by exactly the event it names (an anti-join per table). */
  private async checkRowsHaveEvents(client: PoolClient, tenantId: string, fail: (kind: FailureKind, seq: string | null) => void): Promise<void> {
    for (const table of RECORD_TABLES) {
      // `table` comes from the closed RECORD_TABLES list, never from input.
      const { rows } = await client.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM ${table} t WHERE t.tenant_id = $1 AND NOT EXISTS (
           SELECT 1 FROM ledger_events e WHERE e.id = t.ledger_event_id AND e.tenant_id = t.tenant_id AND e.subject_table = '${table}' AND e.subject_id = t.id)`,
        [tenantId],
      );
      if (rows[0]!.n > 0) fail('row-without-event', null);
    }
  }

  /** Notes: an unredacted note still hashes to its digest; a redacted one is the tombstone and has its redaction event. */
  private async checkNotes(client: PoolClient, tenantId: string, fail: (kind: FailureKind, seq: string | null) => void): Promise<void> {
    let after = '0';
    for (;;) {
      const { rows } = await client.query<{ seq: string; id: string; body: string; body_sha256: string; redacted_at: string | null; has_event: boolean }>(
        `SELECT n.seq::text AS seq, n.id::text AS id, n.body, n.body_sha256, n.redacted_at::text AS redacted_at,
                EXISTS (SELECT 1 FROM ledger_events e WHERE e.subject_table = 'event_notes' AND e.subject_id = n.id AND e.event_type = 'redaction' AND e.tenant_id = n.tenant_id) AS has_event
           FROM event_notes n WHERE n.tenant_id = $1 AND n.seq > $2::bigint ORDER BY n.seq LIMIT 500`,
        [tenantId, after],
      );
      if (rows.length === 0) return;
      for (const n of rows) {
        if (n.redacted_at === null) {
          if (sha256(n.body) !== n.body_sha256 || n.has_event) fail('note-digest-mismatch', null);
        } else if (n.body !== TOMBSTONE || !n.has_event) {
          fail('note-redaction-invalid', null);
        }
        after = n.seq;
      }
    }
  }
}
