import type { PoolClient } from 'pg';
import { ACK_BASIS_RULE, sameAckBasis } from '@telesphoros/shared-types';
import { newId } from '../../ledger/ledger-writer';
import {
  ResultAcknowledgementBasisChangedError,
  ResultAcknowledgementBindingError,
  ResultAcknowledgementDuplicateError,
  type ResultAcknowledgementInput,
  ResultAcknowledgementNotClinicianError,
  ResultAcknowledgementNotFoundError,
  ResultAcknowledgementRequestReusedError,
} from '../result-acknowledgements';
import { resultBasis } from './clinician-decisions';

/**
 * The SQL of result acknowledgements (spec 019, slice D02a). The ledger repository runs it inside its own transaction and appends the event itself
 * (appendEvent has one caller). The write order is D01b's, and it is what makes the guarantees hold:
 *   1. a replay of a stored request is answered from the stored row, BEFORE any other check (a retry after a retraction finds its original);
 *   2. the result, its evaluation and patient are read and compared with the request;
 *   3. the row is inserted, carrying the basis the client displayed; the A5 key refuses a second acknowledgement of the same result, task and kind;
 *   4. the repository appends its event, which takes the tenant's head lock until COMMIT;
 *   5. assertAcknowledgementBasis reads the basis in a FRESH statement after that lock (D01b's BASIS_SQL): every correction, dispute and patient-link
 *      decision also appends under it, so any committed before us is seen, and any later one is ordered after this acknowledgement.
 */

/** SQLSTATE raised by result_acknowledgements_check() (migration *_result_acknowledgements). */
const NOT_CLINICIAN = 'RA001';
/** A5. */
const ONCE_KEY = 'result_acknowledgements_once_uq';

/** Step 5: after the ledger lock, in its own statement. The basis stored is the one displayed, so it is now also the server's at commit. */
export async function assertAcknowledgementBasis(client: PoolClient, tenantId: string, input: ResultAcknowledgementInput): Promise<void> {
  const now = await resultBasis(client, tenantId, input.resultId);
  if (!now || !sameAckBasis(now.basis, input.displayedBasis)) throw new ResultAcknowledgementBasisChangedError();
}

/** Steps 1 to 3. Returns the stored acknowledgement of a replay, or the id of the row just inserted (its event not yet appended). */
export async function insertAcknowledgementRow(
  client: PoolClient,
  tenantId: string,
  actor: string,
  input: ResultAcknowledgementInput,
): Promise<{ replayOf: string } | { inserted: string }> {
  // 1. Replays of one request queue here, so two at once cannot both miss the look-up.
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`result-acknowledgement-request:${tenantId}:${actor}:${input.request.id}`]);
  const replay = await client.query<{ id: string; hash: string }>(
    `SELECT id::text AS id, creation_request_hash AS hash FROM result_acknowledgements WHERE tenant_id = $1 AND created_by = $2 AND creation_request_id = $3`,
    [tenantId, actor, input.request.id],
  );
  if (replay.rows[0]) {
    if (replay.rows[0].hash !== input.request.hash) throw new ResultAcknowledgementRequestReusedError();
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
  if (!binding) throw new ResultAcknowledgementNotFoundError();
  if (binding.patient_id !== input.patientId) throw new ResultAcknowledgementBindingError();

  // 3. The row. The trigger copies the author's roles and membership version over the placeholders and sets the time; the CHECKs refuse a kind the
  //    basis does not allow (A3), and the A5 key a second acknowledgement (mapped by resultAcknowledgementError below).
  const id = newId();
  await client.query(
    `INSERT INTO result_acknowledgements (id, tenant_id, result_id, evaluation_id, patient_id, created_by, author_roles, membership_version, kind, review_task,
                                          basis, basis_rule, ledger_event_id, creation_request_id, creation_request_hash)
     VALUES ($1, $2, $3, $4, $5, $6, '{}', 0, $7, $8, $9::text[], $10, $11, $12, $13)`,
    [
      id,
      tenantId,
      input.resultId,
      binding.evaluation_id,
      binding.patient_id,
      actor,
      input.kind,
      input.reviewTask,
      input.displayedBasis,
      ACK_BASIS_RULE,
      newId(),
      input.request.id,
      input.request.hash,
    ],
  );
  return { inserted: id };
}

/** The trigger's refusal and the A5 key, as the refusals the service answers; anything else passes through unchanged. */
export function resultAcknowledgementError(error: unknown): unknown {
  const { code, constraint } = (error ?? {}) as { code?: string; constraint?: string };
  if (code === NOT_CLINICIAN) return new ResultAcknowledgementNotClinicianError();
  if (code === '23505' && constraint === ONCE_KEY) return new ResultAcknowledgementDuplicateError();
  return error;
}
