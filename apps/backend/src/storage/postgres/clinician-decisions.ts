import type { PoolClient } from 'pg';
import { CDR_ELIGIBILITY_POLICY, CDR_VOCABULARY_VERSION } from '@telesphoros/shared-types';
import { newId } from '../../ledger/ledger-writer';
import {
  type CdrBasis,
  ClinicianDecisionBasisError,
  ClinicianDecisionBindingError,
  type ClinicianDecisionInput,
  ClinicianDecisionNotAuthorError,
  ClinicianDecisionNotClinicianError,
  ClinicianDecisionNotFoundError,
  ClinicianDecisionRequestReusedError,
  ClinicianDecisionRuleError,
  ClinicianDecisionStaleError,
  type ResultBasis,
} from '../clinician-decisions';

/**
 * The SQL of clinician result decisions (spec 006, slice D01b). The ledger repository runs it inside its own transaction and appends the event
 * itself (appendEvent has one caller). The write order is what makes the guarantees hold:
 *   1. a replay of a stored request is answered from the stored row, BEFORE any eligibility check (a retry after a retraction finds its original);
 *   2. the result, its evaluation and patient are read and compared with the request;
 *   3. writers on one result queue on a lock, so "the head" read next is the head the insert extends (the chain keys are the guarantee);
 *   4. the row is inserted; then the repository appends its event, which takes the tenant's head lock until COMMIT;
 *   5. assertDecisionBasis reads the basis rule in a FRESH statement after that lock: every correction, dispute and patient-link decision also
 *      appends under it, so any committed before us is seen, and any later one is ordered after this decision.
 */

/** SQLSTATEs raised by clinician_result_decisions_check() (migration *_clinician_result_decisions). */
const NOT_CLINICIAN = 'CD001';
const NOT_AUTHOR = 'CD002';
const WITHDRAW_WITHDRAWAL = 'CD003';
const TIME_WINDOW = 'CD004';
const CHAIN_KEYS = ['clinician_result_decisions_first_uq', 'clinician_result_decisions_successor_uq'];

/**
 * The newest decision `d` about the report `rp` still applies (LINK_APPLIES in ledger-records.repository.ts, for the report alias used here).
 */
const LINK_APPLIES_RP = `d.report_sha256 = rp.sha256 AND d.object_version = rp.object_version AND d.patient_id = rp.patient_id`;

/**
 * The basis of one result now, in one statement (`$1` tenant, `$2` result). The categories restate the current-evaluation rule
 * (CURRENT_EVALUATIONS_SQL in ledger-records.repository.ts): newest of its report, not quarantined, last correction not a retraction or
 * supersession. `disputed` is a dispute in force (open, or decided `upheld`) on the result's cited cell, matched as cellEvaluationCandidates does.
 */
const BASIS_SQL = `
  SELECT r.id::text AS result_id, e.id::text AS evaluation_id, e.patient_id::text AS patient_id, r.outcome,
         EXISTS (SELECT 1 FROM evaluations n WHERE n.tenant_id = e.tenant_id AND n.report_id = e.report_id AND n.seq > e.seq) AS not_newest,
         (SELECT c.kind FROM corrections c
           WHERE c.tenant_id = e.tenant_id AND c.evaluation_id = e.id
             AND NOT EXISTS (SELECT 1 FROM corrections x WHERE x.tenant_id = c.tenant_id AND x.previous_correction_id = c.id)
           ORDER BY c.seq DESC LIMIT 1) AS last_correction,
         EXISTS (
           SELECT 1 FROM reports rp
             JOIN LATERAL (SELECT x.* FROM report_patient_decisions x WHERE x.tenant_id = rp.tenant_id AND x.report_id = rp.id ORDER BY x.seq DESC LIMIT 1) d ON true
            WHERE rp.id = e.report_id AND rp.tenant_id = e.tenant_id AND d.decision = 'rejected' AND (${LINK_APPLIES_RP})) AS quarantined,
         (r.guideline_id IS NOT NULL AND EXISTS (
           SELECT 1 FROM cell_disputes cd
             LEFT JOIN cell_dispute_decisions dd ON dd.dispute_id = cd.id AND dd.tenant_id = cd.tenant_id
            WHERE cd.tenant_id = r.tenant_id AND (dd.id IS NULL OR dd.decision = 'upheld')
              AND cd.guideline_id = r.guideline_id AND cd.guideline_version = r.guideline_version
              AND cd.locator_table = r.citation->'locator'->>'table' AND cd.locator_row = r.citation->'locator'->>'row'
              AND cd.locator_column IS NOT DISTINCT FROM (r.citation->'locator'->>'column'))) AS disputed
    FROM evaluation_results r JOIN evaluations e ON e.id = r.evaluation_id AND e.tenant_id = r.tenant_id
   WHERE r.tenant_id = $1 AND r.id = $2`;

interface BasisRow {
  result_id: string;
  evaluation_id: string;
  patient_id: string;
  outcome: string;
  not_newest: boolean;
  last_correction: string | null;
  quarantined: boolean;
  disputed: boolean;
}

function toBasis(row: BasisRow): ResultBasis {
  const basis: CdrBasis[] = [];
  if (row.last_correction === 'retraction') basis.push('retracted');
  if (row.last_correction === 'supersession') basis.push('superseded');
  if (row.quarantined) basis.push('quarantined');
  if (row.disputed) basis.push('disputed');
  if (row.not_newest) basis.push('not-current');
  if (basis.length === 0) basis.push('active');
  return {
    resultId: row.result_id,
    evaluationId: row.evaluation_id,
    patientId: row.patient_id,
    basis,
    eligible: basis.length === 1 && basis[0] === 'active' && row.outcome !== 'held',
  };
}

export async function resultBasis(client: PoolClient, tenantId: string, resultId: string): Promise<ResultBasis | undefined> {
  const { rows } = await client.query<BasisRow>(BASIS_SQL, [tenantId, resultId]);
  return rows[0] ? toBasis(rows[0]) : undefined;
}

/** Step 5: after the ledger lock, in its own statement. */
export async function assertDecisionBasis(client: PoolClient, tenantId: string, resultId: string): Promise<void> {
  if (!(await resultBasis(client, tenantId, resultId))?.eligible) throw new ClinicianDecisionBasisError();
}

/** Steps 1 to 4. Returns the stored entry of a replay, or the id of the row just inserted (its event not yet appended). */
export async function insertDecisionRow(
  client: PoolClient,
  tenantId: string,
  actor: string,
  input: ClinicianDecisionInput,
  insertNote: (body: string) => Promise<string>,
): Promise<{ replayOf: string } | { inserted: string }> {
  // 1. Replays of one request queue here, so two at once cannot both miss the look-up.
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`clinician-decision-request:${tenantId}:${actor}:${input.request.id}`]);
  const replay = await client.query<{ id: string; hash: string }>(
    `SELECT id::text AS id, creation_request_hash AS hash FROM clinician_result_decisions WHERE tenant_id = $1 AND created_by = $2 AND creation_request_id = $3`,
    [tenantId, actor, input.request.id],
  );
  if (replay.rows[0]) {
    if (replay.rows[0].hash !== input.request.hash) throw new ClinicianDecisionRequestReusedError();
    return { replayOf: replay.rows[0].id };
  }

  // 2. The stored relationship, not the request's, decides; another tenant's result is simply not found.
  const bound = await client.query<{ evaluation_id: string; patient_id: string }>(
    `SELECT r.evaluation_id::text AS evaluation_id, e.patient_id::text AS patient_id
       FROM evaluation_results r JOIN evaluations e ON e.id = r.evaluation_id AND e.tenant_id = r.tenant_id
      WHERE r.tenant_id = $1 AND r.id = $2`,
    [tenantId, input.resultId],
  );
  const binding = bound.rows[0];
  if (!binding) throw new ClinicianDecisionNotFoundError();
  if (binding.evaluation_id !== input.evaluationId || binding.patient_id !== input.patientId) throw new ClinicianDecisionBindingError();

  // 3. One writer per result at a time; the head read under this lock is the head the insert extends.
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`clinician-decision:${tenantId}:${input.resultId}`]);
  const head = await client.query<{ id: string }>(
    `SELECT d.id::text AS id FROM clinician_result_decisions d
      WHERE d.tenant_id = $1 AND d.result_id = $2
        AND NOT EXISTS (SELECT 1 FROM clinician_result_decisions s WHERE s.previous_entry_id = d.id)`,
    [tenantId, input.resultId],
  );
  if ((head.rows[0]?.id ?? null) !== input.previousEntryId) throw new ClinicianDecisionStaleError();

  // 4. The row. The trigger copies the author's roles and membership version over the placeholders, sets the times, and refuses an amendment or
  //    withdrawal of another author's entry (CD002) or of a withdrawal (CD003): one guarantee, mapped by clinicianDecisionError below.
  const id = newId();
  const noteId = input.note === undefined ? null : await insertNote(input.note);
  await client.query(
    `INSERT INTO clinician_result_decisions (id, tenant_id, result_id, evaluation_id, patient_id, created_by, author_roles, membership_version, entry_kind,
                                             previous_entry_id, response, detail_codes, review_by, note_id, vocabulary_version, occurred_at, occurred_at_source,
                                             eligibility_policy, ledger_event_id, creation_request_id, creation_request_hash)
     VALUES ($1, $2, $3, $4, $5, $6, '{}', 0, $7, $8, $9, $10::text[], $11::date, $12, $13, $14::timestamptz, 'reported', $15, $16, $17, $18)`,
    [
      id,
      tenantId,
      input.resultId,
      binding.evaluation_id,
      binding.patient_id,
      actor,
      input.entryKind,
      input.previousEntryId,
      input.response,
      input.detailCodes,
      input.reviewBy,
      noteId,
      CDR_VOCABULARY_VERSION,
      input.occurredAt ?? null,
      CDR_ELIGIBILITY_POLICY,
      newId(),
      input.request.id,
      input.request.hash,
    ],
  );
  return { inserted: id };
}

/** The trigger's refusals and the chain keys, as the refusals the service answers; anything else passes through unchanged. */
export function clinicianDecisionError(error: unknown): unknown {
  const { code, constraint } = (error ?? {}) as { code?: string; constraint?: string };
  if (code === NOT_CLINICIAN) return new ClinicianDecisionNotClinicianError();
  if (code === NOT_AUTHOR) return new ClinicianDecisionNotAuthorError();
  if (code === WITHDRAW_WITHDRAWAL) return new ClinicianDecisionRuleError('entryKind');
  if (code === TIME_WINDOW) return new ClinicianDecisionRuleError('occurredAt');
  if (code === '23505' && constraint && CHAIN_KEYS.includes(constraint)) return new ClinicianDecisionStaleError();
  return error;
}
