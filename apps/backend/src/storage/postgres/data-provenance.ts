import type { PoolClient } from 'pg';
import { requireDataOrigin, type DataOrigin } from '../../ledger/data-origin';
import { newId } from '../../ledger/ledger-writer';

/**
 * Spec 020 E1a: the provenance row of one fact, written in the fact's own transaction by the repository that writes the fact. The values come from the
 * rows the transaction already holds (the locked report, the stored capture), the server's origin and the engine's own stamps, never from a request.
 * The row's ledger event is appended by the caller (`finish`), after the fact's own.
 */

/** A capture: runner and Poppler version, the PDF's hash and object version, and the report's upload time. The parent asset is the report. */
export async function insertCaptureProvenance(
  client: PoolClient,
  tenantId: string,
  actor: string,
  captureId: string,
  input: { origin: DataOrigin; reportId: string; pdfSha256: string; objectVersion: string; receivedAt: Date; runner: string; popplerVersion: string },
): Promise<string> {
  const origin = requireDataOrigin(input.origin);
  const id = newId();
  await client.query(
    `INSERT INTO data_provenance (id, tenant_id, created_by, ledger_event_id, subject_kind, capture_id, origin, interpretation, document_sha256, object_version, received_at,
                                  transform_runner, transform_poppler_version, parent_kind, parent_id)
       VALUES ($1, $2, $3, $4, 'capture', $5, $6, NULL, $7, $8, $9, $10, $11, 'report', $12)`,
    [id, tenantId, actor, newId(), captureId, origin, input.pdfSha256, input.objectVersion, input.receivedAt, input.runner, input.popplerVersion, input.reportId],
  );
  return id;
}

/**
 * An evaluation: software-derived, the capture's PDF hash read through the capture, the engine version and knowledge set. The parent asset is the
 * capture acceptance the evaluation relied on, or the capture itself when it relied on none (a capture that needs no decision).
 */
export async function insertEvaluationProvenance(
  client: PoolClient,
  tenantId: string,
  actor: string,
  evaluationId: string,
  input: { origin: DataOrigin; captureId: string; captureAcceptanceId: string | null; engineVersion: string; knowledgeSetId: string },
): Promise<string> {
  const origin = requireDataOrigin(input.origin);
  const id = newId();
  const inserted = await client.query(
    `INSERT INTO data_provenance (id, tenant_id, created_by, ledger_event_id, subject_kind, evaluation_id, origin, interpretation, document_sha256,
                                  transform_engine_version, transform_knowledge_set_id, parent_kind, parent_id)
       SELECT $1, $2, $3, $4, 'evaluation', $5, $6, 'software-derived', c.pdf_sha256, $7, $8, $9, $10
         FROM report_captures c WHERE c.id = $11 AND c.tenant_id = $2`,
    [
      id,
      tenantId,
      actor,
      newId(),
      evaluationId,
      origin,
      input.engineVersion,
      input.knowledgeSetId,
      input.captureAcceptanceId === null ? 'capture' : 'capture-acceptance',
      input.captureAcceptanceId ?? input.captureId,
      input.captureId,
    ],
  );
  // The evaluation's own foreign key already guarantees the capture; this only guards the statement's shape.
  if (inserted.rowCount !== 1) throw new Error('The capture an evaluation rests on was not found, so its provenance cannot be stored.');
  return id;
}
