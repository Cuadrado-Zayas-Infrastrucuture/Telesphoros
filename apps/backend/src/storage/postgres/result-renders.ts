import type { PoolClient } from 'pg';
import type { ResultRenderBatch, ResultRenderBatchResult } from '@telesphoros/shared-types';
import type { Database } from '../../db/database';
import { ResultRenderExposureMissingError, ResultRenderNotFoundError, ResultRenderNotReaderError } from '../result-renders';

/**
 * The SQL of render capture (spec 019, slice D02b). Not a ledger record (plan P3): one transaction, no event, no projection. The order:
 *   1. the caller's batches queue on one lock, so a retried batch and its original cannot both miss each other's exposure;
 *   2. every result the batch names is read in the caller's organization; one that is not found refuses the whole batch (FR-02, all or nothing);
 *   3. every duration needs its exposure, earlier in this batch or already stored, for the same result and path (R1); one without it is skipped and
 *      counted, not refused with the batch: its exposure was lost on the way, and refusing would drop every other event queued with it;
 *   4. the rows go in, exposure before duration, and one whose (episode, seq) is stored already is skipped (FR-04): a retry stores nothing twice.
 * The trigger (migration *_result_render_events) checks the viewer's live membership and step 3 again; these steps give the clear refusals.
 */

/** SQLSTATEs raised by result_render_events_check(). */
const NOT_READER = 'RR001';
const NO_EXPOSURE = 'RR002';
/** FR-04. */
const ONCE_KEY = 'result_render_events_once_uq';

export class PostgresResultRendersRepository {
  constructor(private readonly database: Database) {}

  record(tenantId: string, viewer: string, batch: ResultRenderBatch): Promise<ResultRenderBatchResult> {
    return this.database
      .withTenant(tenantId, (client) => recordBatch(client, tenantId, viewer, batch), { actor: viewer })
      .catch((error: unknown) => {
        throw resultRenderError(error);
      });
  }
}

export async function recordBatch(client: PoolClient, tenantId: string, viewer: string, batch: ResultRenderBatch): Promise<ResultRenderBatchResult> {
  // 1.
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`result-render:${tenantId}:${viewer}`]);
  const events = batch.events
    .map((e) => ({ ...e, episodeId: e.episodeId.toLowerCase(), resultId: e.resultId.toLowerCase() }))
    .sort((a, b) => (a.episodeId === b.episodeId ? a.seq - b.seq : a.episodeId < b.episodeId ? -1 : 1));

  // 2. The stored relationship decides the evaluation and patient; another tenant's result is simply not found.
  const ids = [...new Set(events.map((e) => e.resultId))];
  const bound = await client.query<{ id: string; evaluation_id: string; patient_id: string }>(
    `SELECT r.id::text AS id, r.evaluation_id::text AS evaluation_id, e.patient_id::text AS patient_id
       FROM evaluation_results r JOIN evaluations e ON e.id = r.evaluation_id AND e.tenant_id = r.tenant_id
      WHERE r.tenant_id = $1 AND r.id = ANY($2::uuid[])`,
    [tenantId, ids],
  );
  const binding = new Map(bound.rows.map((r) => [r.id, r]));
  if (ids.some((id) => !binding.has(id))) throw new ResultRenderNotFoundError();

  // 3. An exposure in this batch, or one stored before, for the same episode, result and path.
  const key = (e: { episodeId: string; resultId: string; measurement: string }) => `${e.episodeId}:${e.resultId}:${e.measurement}`;
  const exposures = new Set(events.filter((e) => e.seq === 0).map(key));
  let orphans = events.filter((e) => e.seq > 0 && !exposures.has(key(e)));
  if (orphans.length > 0) {
    const stored = await client.query<{ episode_id: string; result_id: string; measurement: string }>(
      `SELECT episode_id::text AS episode_id, result_id::text AS result_id, measurement FROM result_render_events
        WHERE tenant_id = $1 AND viewer = $2 AND seq = 0 AND episode_id = ANY($3::uuid[])`,
      [tenantId, viewer, [...new Set(orphans.map((e) => e.episodeId))]],
    );
    for (const r of stored.rows) exposures.add(key({ episodeId: r.episode_id, resultId: r.result_id, measurement: r.measurement }));
    orphans = orphans.filter((e) => !exposures.has(key(e)));
  }
  const withoutExposure = orphans.length;
  const kept = withoutExposure === 0 ? events : events.filter((e) => !orphans.includes(e));
  if (kept.length === 0) return { stored: 0, alreadyStored: 0, withoutExposure };

  // 4. The trigger copies the viewer's roles and membership version over the placeholders and sets the receipt time.
  const rows = kept.map((e, ord) => ({
    ord,
    episode_id: e.episodeId,
    seq: e.seq,
    kind: e.kind,
    result_id: e.resultId,
    evaluation_id: binding.get(e.resultId)!.evaluation_id,
    patient_id: binding.get(e.resultId)!.patient_id,
    measurement: e.measurement,
    rule_version: e.ruleVersion,
    schema_version: e.schemaVersion,
    capability: e.capability,
    occurred_at: e.occurredAt,
    continuous_ms: e.continuousMs,
    cumulative_ms: e.cumulativeMs,
  }));
  const inserted = await client.query(
    `INSERT INTO result_render_events (tenant_id, episode_id, seq, kind, result_id, evaluation_id, patient_id, viewer, viewer_roles, membership_version,
                                       measurement, rule_version, schema_version, capability, occurred_at, sent_at, continuous_ms, cumulative_ms)
     SELECT $1, e.episode_id, e.seq, e.kind, e.result_id, e.evaluation_id, e.patient_id, $2, '{}', 0,
            e.measurement, e.rule_version, e.schema_version, e.capability, e.occurred_at, $3::timestamptz, e.continuous_ms, e.cumulative_ms
       FROM jsonb_to_recordset($4::jsonb) AS e(ord int, episode_id uuid, seq int, kind text, result_id uuid, evaluation_id uuid, patient_id uuid,
                                               measurement text, rule_version text, schema_version int, capability text[], occurred_at timestamptz,
                                               continuous_ms int, cumulative_ms int)
      ORDER BY e.ord
     ON CONFLICT ON CONSTRAINT ${ONCE_KEY} DO NOTHING
     RETURNING id`,
    [tenantId, viewer, batch.sentAt, JSON.stringify(rows)],
  );
  const stored = inserted.rowCount ?? 0;
  return { stored, alreadyStored: kept.length - stored, withoutExposure };
}

/** The trigger's refusals, as the refusals the service answers; anything else passes through unchanged. */
export function resultRenderError(error: unknown): unknown {
  const { code } = (error ?? {}) as { code?: string };
  if (code === NOT_READER || code === '42501') return new ResultRenderNotReaderError();
  if (code === NO_EXPOSURE) return new ResultRenderExposureMissingError();
  return error;
}
