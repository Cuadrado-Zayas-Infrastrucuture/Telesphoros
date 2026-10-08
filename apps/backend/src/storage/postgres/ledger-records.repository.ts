import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { Database } from '../../db/database';
import { appendEvent, newId } from '../../ledger/ledger-writer';
import { DisputeActiveError, StaleAcceptanceError, SourceChangedError, toLedgerError, type RecordTable } from '../../ledger/ledger-types';
import { loadProjections } from '../../ledger/projections';
import { canonicalHash } from '../../services/report-adapter/canonical-json';
import { LedgerRecordsRepository } from '../ledger-records.repository';
import type {
  AcceptanceInput, CaptureInput, CorrectionInput, DisputeDecisionInput, DisputeInput, DisputeStatus, EvaluationInput, EvaluationState, InsertResult, NoteRecord, Projected,
} from '../ledger-records';

/**
 * PostgreSQL implementation of the ledger records. The rules (who may write, what must agree, what can never change) live in the
 * migrations; this class only sequences the statements so that they hold:
 *
 *   1. insert the record, its children and its notes;
 *   2. as the LAST statement, append the ledger event (so the ledger's head lock is held only until COMMIT);
 *   3. COMMIT, where the database refuses the transaction if a record and its event do not match.
 *
 * Reads return the projection of the stored row, i.e. exactly the object the event's hash covers.
 */
@Injectable()
export class PostgresLedgerRecordsRepository extends LedgerRecordsRepository {
  constructor(private readonly db: Database) {
    super();
  }

  insertCapture(tenantId: string, actor: string, input: CaptureInput): Promise<InsertResult> {
    return this.write(tenantId, actor, async (client) => {
      // The report row is locked FOR SHARE for the rest of this transaction: a concurrent change to it waits for us, and one that
      // committed before is seen here. Then what the caller relied on is compared with what is there NOW.
      const locked = await client.query<{ type: string; patient_id: string; sha256: string | null; object_version: string | null; storage_key: string | null; uploaded: boolean; deleted: boolean }>(
        `SELECT type, patient_id::text AS patient_id, sha256, object_version, storage_key, uploaded_at IS NOT NULL AS uploaded, deleted_at IS NOT NULL AS deleted
           FROM reports WHERE id = $1 AND tenant_id = $2 FOR SHARE`,
        [input.reportId, tenantId],
      );
      const report = locked.rows[0];
      const expected = input.expectedReport;
      if (!report || report.deleted || !report.uploaded || report.type !== 'lab-pdf' || report.patient_id !== expected.patientId || report.sha256 !== expected.sha256
        || report.object_version !== expected.objectVersion || report.storage_key !== expected.storageKey || report.sha256 !== input.pdfSha256) {
        throw new SourceChangedError();
      }
      const existing = await client.query<{ id: string }>(
        `SELECT id::text AS id FROM report_captures WHERE tenant_id = $1 AND report_id = $2 AND text_sha256 = $3 AND poppler_version = $4`,
        [tenantId, input.reportId, input.textSha256, input.popplerVersion],
      );
      if (existing.rows[0]) return this.existing(client, tenantId, 'report_captures', existing.rows[0].id);
      const id = newId();
      const inserted = await client.query(
        `INSERT INTO report_captures (id, tenant_id, created_by, ledger_event_id, report_id, pdf_sha256, text_storage_key, text_sha256, text_scalars, poppler_version, runner)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         ON CONFLICT ON CONSTRAINT report_captures_identity_uq DO NOTHING RETURNING id`,
        [id, tenantId, actor, newId(), input.reportId, input.pdfSha256, input.textStorageKey, input.textSha256, input.textScalars, input.popplerVersion, input.runner],
      );
      if (inserted.rowCount === 0) return this.raced(client, tenantId, 'report_captures', 'report_captures_identity_uq', [input.reportId, input.textSha256, input.popplerVersion]);
      return this.finish(client, tenantId, 'report_captures', id);
    });
  }

  findCapture(tenantId: string, id: string): Promise<Projected | undefined> {
    return this.read(tenantId, (client) => this.one(client, tenantId, 'report_captures', id));
  }

  findCaptureByIdentity(tenantId: string, identity: { reportId: string; textSha256: string; popplerVersion: string }): Promise<Projected | undefined> {
    return this.read(tenantId, async (client) => {
      const { rows } = await client.query<{ id: string }>(
        `SELECT id::text AS id FROM report_captures WHERE tenant_id = $1 AND report_id = $2 AND text_sha256 = $3 AND poppler_version = $4`,
        [tenantId, identity.reportId, identity.textSha256, identity.popplerVersion],
      );
      return rows[0] ? this.one(client, tenantId, 'report_captures', rows[0].id) : undefined;
    });
  }

  findAcceptance(tenantId: string, id: string): Promise<Projected | undefined> {
    return this.read(tenantId, (client) => this.one(client, tenantId, 'capture_acceptances', id));
  }

  insertAcceptance(tenantId: string, actor: string, input: AcceptanceInput): Promise<InsertResult> {
    return this.write(tenantId, actor, async (client) => {
      const id = newId();
      const noteId = input.note === undefined ? null : await this.insertNote(client, tenantId, actor, input.note);
      await client.query(
        `INSERT INTO capture_acceptances (id, tenant_id, created_by, ledger_event_id, capture_id, decision, text_sha256, poppler_version, note_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [id, tenantId, actor, newId(), input.captureId, input.decision, input.textSha256, input.popplerVersion, noteId],
      );
      return this.finish(client, tenantId, 'capture_acceptances', id);
    });
  }

  latestAcceptance(tenantId: string, captureId: string): Promise<Projected | undefined> {
    return this.read(tenantId, async (client) => {
      const { rows } = await client.query<{ id: string }>(
        `SELECT id::text AS id FROM capture_acceptances WHERE tenant_id = $1 AND capture_id = $2 ORDER BY seq DESC LIMIT 1`,
        [tenantId, captureId],
      );
      return rows[0] ? this.one(client, tenantId, 'capture_acceptances', rows[0].id) : undefined;
    });
  }

  insertEvaluation(tenantId: string, actor: string, input: EvaluationInput): Promise<InsertResult> {
    const identityKey = evaluationIdentityKey(input);
    return this.write(tenantId, actor, async (client) => {
      const existing = await client.query<{ id: string }>(`SELECT id::text AS id FROM evaluations WHERE tenant_id = $1 AND identity_key = $2`, [tenantId, identityKey]);
      if (existing.rows[0]) return this.existing(client, tenantId, 'evaluations', existing.rows[0].id);
      const id = newId();
      const inserted = await client.query(
        `INSERT INTO evaluations (id, tenant_id, created_by, ledger_event_id, patient_id, report_id, capture_id, capture_acceptance_id, disposition, hold_code,
                                  binding, knowledge_set_id, engine_version, gene_inputs, occurrences, identity_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, $13, $14::jsonb, $15::jsonb, $16)
         ON CONFLICT ON CONSTRAINT evaluations_identity_uq DO NOTHING RETURNING id`,
        [id, tenantId, actor, newId(), input.patientId, input.reportId, input.captureId, input.captureAcceptanceId, input.disposition, input.holdCode,
         JSON.stringify(input.binding), input.knowledgeSetId, input.engineVersion, JSON.stringify(input.geneInputs), JSON.stringify(input.occurrences), identityKey],
      );
      if (inserted.rowCount === 0) return this.raced(client, tenantId, 'evaluations', 'evaluations_identity_uq', undefined, identityKey);
      let ordinal = 0;
      for (const result of input.results) {
        const citation = 'citation' in result ? result.citation : null;
        await client.query(
          `INSERT INTO evaluation_results (tenant_id, evaluation_id, ordinal, drug, genes, outcome, reason_code, strength, citation, guideline_id, guideline_version,
                                           recommendation_text, implication, gene_evidence)
           VALUES ($1, $2, $3, $4, $5::text[], $6, $7, $8, $9::jsonb, $10, $11, $12, $13, $14::jsonb)`,
          [tenantId, id, ordinal++, result.drug, result.genes, result.outcome, 'reasonCode' in result ? result.reasonCode : null,
           'strength' in result ? result.strength : null, citation ? JSON.stringify(citation) : null, citation?.guidelineId ?? null, citation?.guidelineVersion ?? null,
           'recommendationText' in result ? result.recommendationText : null, 'implication' in result ? result.implication : null, JSON.stringify(result.geneStates)],
        );
      }
      for (const state of input.geneStates) {
        await client.query(
          `INSERT INTO evaluation_gene_states (tenant_id, evaluation_id, gene, state, phenotype, diplotype, activity_score, reason_code)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [tenantId, id, state.gene, state.state, state.phenotype, state.diplotype, state.activityScore, state.reasonCode],
        );
      }
      const stored = await this.finish(client, tenantId, 'evaluations', id);
      // Capture decisions append under this same lock. A fresh statement sees any decision committed before we acquired it.
      if (input.captureAcceptanceId !== null) await this.assertCurrentAcceptance(client, tenantId, input.captureId, input.captureAcceptanceId);
      // The append above took the tenant's ledger head lock and keeps it until COMMIT. Raising or deciding a dispute also appends, so it
      // needs the same lock: every dispute change is either committed before we got the lock (and this separate statement, a new
      // snapshot under READ COMMITTED, sees it) or queued behind us (and is ordered after this evaluation).
      if (input.disposition === 'evaluated') await this.assertNoActiveDispute(client, tenantId);
      return stored;
    });
  }

  activeDisputeExists(tenantId: string): Promise<boolean> {
    return this.read(tenantId, (client) => this.hasActiveDispute(client, tenantId));
  }

  private async assertCurrentAcceptance(client: PoolClient, tenantId: string, captureId: string, acceptanceId: string): Promise<void> {
    const { rows } = await client.query<{ id: string; decision: string }>(
      `SELECT id::text AS id, decision FROM capture_acceptances
        WHERE tenant_id = $1 AND capture_id = $2 ORDER BY seq DESC LIMIT 1`,
      [tenantId, captureId],
    );
    if (!rows[0] || rows[0].id !== acceptanceId || rows[0].decision !== 'accepted') throw new StaleAcceptanceError();
  }

  private async hasActiveDispute(client: PoolClient, tenantId: string): Promise<boolean> {
    const { rows } = await client.query<{ active: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM cell_disputes d
           LEFT JOIN cell_dispute_decisions x ON x.dispute_id = d.id AND x.tenant_id = d.tenant_id
          WHERE d.tenant_id = $1 AND (x.id IS NULL OR x.decision = 'upheld')
       ) AS active`,
      [tenantId],
    );
    return rows[0]!.active;
  }

  /** Its own statement, never part of the append: that is what gives it a fresh snapshot after the lock is held. */
  private async assertNoActiveDispute(client: PoolClient, tenantId: string): Promise<void> {
    if (await this.hasActiveDispute(client, tenantId)) throw new DisputeActiveError();
  }

  findEvaluation(tenantId: string, id: string): Promise<Projected | undefined> {
    return this.read(tenantId, (client) => this.one(client, tenantId, 'evaluations', id));
  }

  listEvaluations(tenantId: string, filter: { reportId?: string; patientId?: string; current?: boolean }): Promise<Projected[]> {
    return this.read(tenantId, async (client) => {
      const { rows } = await client.query<{ id: string }>(
        `SELECT e.id::text AS id FROM evaluations e
          WHERE e.tenant_id = $1 AND ($2::uuid IS NULL OR e.report_id = $2::uuid) AND ($3::uuid IS NULL OR e.patient_id = $3::uuid)
            AND (NOT $4::boolean OR e.id IN (${CURRENT_EVALUATIONS_SQL}))
          ORDER BY e.seq`,
        [tenantId, filter.reportId ?? null, filter.patientId ?? null, filter.current === true],
      );
      return this.many(client, tenantId, 'evaluations', rows.map((r) => r.id));
    });
  }

  currentEvaluationIds(tenantId: string, reportIds: string[]): Promise<Map<string, string | null>> {
    return this.read(tenantId, async (client) => {
      const { rows } = await client.query<{ report_id: string; id: string }>(
        `SELECT e.report_id::text AS report_id, e.id::text AS id FROM evaluations e WHERE e.id IN (${CURRENT_EVALUATIONS_SQL}) AND e.report_id = ANY($2::uuid[])`,
        [tenantId, reportIds],
      );
      const found = new Map(rows.map((r) => [r.report_id, r.id]));
      return new Map(reportIds.map((reportId) => [reportId, found.get(reportId) ?? null]));
    });
  }

  insertCorrection(tenantId: string, actor: string, input: CorrectionInput): Promise<InsertResult> {
    return this.write(tenantId, actor, async (client) => {
      const id = newId();
      const noteId = input.note === undefined ? null : await this.insertNote(client, tenantId, actor, input.note);
      // report_id is copied from the evaluation inside the statement, so a caller cannot name a different report.
      await client.query(
        `INSERT INTO corrections (id, tenant_id, created_by, ledger_event_id, evaluation_id, report_id, kind, reason_code, previous_correction_id, replacement_evaluation_id, note_id)
         SELECT $1, $2, $3, $4, e.id, e.report_id, $6, $7, $8::uuid, $9::uuid, $10::uuid FROM evaluations e WHERE e.id = $5::uuid AND e.tenant_id = $2`,
        [id, tenantId, actor, newId(), input.evaluationId, input.kind, input.reasonCode, input.previousCorrectionId ?? null, input.replacementEvaluationId ?? null, noteId],
      ).then((result) => {
        if (result.rowCount === 0) throw toLedgerError(Object.assign(new Error('evaluation not found'), { code: '23503', constraint: 'corrections_evaluation_fk' }));
      });
      return this.finish(client, tenantId, 'corrections', id);
    });
  }

  listCorrections(tenantId: string, evaluationId: string): Promise<Projected[]> {
    return this.read(tenantId, async (client) => {
      const { rows } = await client.query<{ id: string }>(`SELECT id::text AS id FROM corrections WHERE tenant_id = $1 AND evaluation_id = $2 ORDER BY seq`, [tenantId, evaluationId]);
      return this.many(client, tenantId, 'corrections', rows.map((r) => r.id));
    });
  }

  evaluationState(tenantId: string, evaluationId: string): Promise<EvaluationState> {
    return this.read(tenantId, async (client) => {
      const { rows } = await client.query<{ kind: string; replacement: string | null }>(
        `SELECT kind, replacement_evaluation_id::text AS replacement FROM corrections WHERE tenant_id = $1 AND evaluation_id = $2 ORDER BY seq DESC LIMIT 1`,
        [tenantId, evaluationId],
      );
      const last = rows[0];
      if (!last || last.kind === 'reinstatement') return { state: 'active' } as const;
      if (last.kind === 'retraction') return { state: 'retracted' } as const;
      return { state: 'superseded', by: last.replacement! } as const;
    });
  }

  raiseDispute(tenantId: string, actor: string, input: DisputeInput): Promise<InsertResult> {
    return this.write(tenantId, actor, async (client) => {
      const id = newId();
      const noteId = await this.insertNote(client, tenantId, actor, input.note);
      await client.query(
        `INSERT INTO cell_disputes (id, tenant_id, created_by, ledger_event_id, guideline_id, guideline_version, guideline_content_sha256, locator_table, locator_row, locator_column, note_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [id, tenantId, actor, newId(), input.guidelineId, input.guidelineVersion, input.guidelineContentSha256, input.locator.table, input.locator.row, input.locator.column ?? null, noteId],
      );
      return this.finish(client, tenantId, 'cell_disputes', id);
    });
  }

  decideDispute(tenantId: string, actor: string, input: DisputeDecisionInput): Promise<InsertResult> {
    return this.write(tenantId, actor, async (client) => {
      const id = newId();
      const noteId = await this.insertNote(client, tenantId, actor, input.evidenceNote);
      await client.query(
        `INSERT INTO cell_dispute_decisions (id, tenant_id, created_by, ledger_event_id, dispute_id, decision, evidence_note_id) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [id, tenantId, actor, newId(), input.disputeId, input.decision, noteId],
      );
      return this.finish(client, tenantId, 'cell_dispute_decisions', id);
    });
  }

  listDisputes(tenantId: string): Promise<DisputeStatus[]> {
    return this.read(tenantId, async (client) => {
      const disputes = await client.query<{ id: string; decision_id: string | null }>(
        `SELECT d.id::text AS id, x.id::text AS decision_id FROM cell_disputes d
           LEFT JOIN cell_dispute_decisions x ON x.dispute_id = d.id AND x.tenant_id = d.tenant_id
          WHERE d.tenant_id = $1 ORDER BY d.seq`,
        [tenantId],
      );
      const disputeRows = await this.many(client, tenantId, 'cell_disputes', disputes.rows.map((r) => r.id));
      const decisionIds = disputes.rows.flatMap((r) => (r.decision_id ? [r.decision_id] : []));
      const decisions = new Map((await this.many(client, tenantId, 'cell_dispute_decisions', decisionIds)).map((d) => [d.id, d]));
      return disputes.rows.map((row, index) => {
        const decision = row.decision_id ? decisions.get(row.decision_id)! : null;
        return { dispute: disputeRows[index]!, status: decision ? (decision.decision as 'upheld' | 'dismissed') : 'open', decision };
      });
    });
  }

  findNote(tenantId: string, id: string): Promise<NoteRecord | undefined> {
    return this.read(tenantId, async (client) => {
      const { rows } = await client.query<{ id: string; body: string; body_sha256: string; redacted: boolean; created_at: string }>(
        `SELECT id::text AS id, body, body_sha256, redacted_at IS NOT NULL AS redacted,
                to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at
           FROM event_notes WHERE id = $1 AND tenant_id = $2`,
        [id, tenantId],
      );
      const row = rows[0];
      return row ? { id: row.id, body: row.body, bodySha256: row.body_sha256, redacted: row.redacted, createdAt: row.created_at } : undefined;
    });
  }

  // ---- plumbing -------------------------------------------------------------------------------------------------------------

  /** One tenant- and actor-scoped transaction; any integrity refusal (also at COMMIT) becomes a LedgerIntegrityError. */
  private async write<T>(tenantId: string, actor: string, work: (client: PoolClient) => Promise<T>): Promise<T> {
    try {
      return await this.db.withTenant(tenantId, work, { actor });
    } catch (error) {
      throw toLedgerError(error);
    }
  }

  private read<T>(tenantId: string, work: (client: PoolClient) => Promise<T>): Promise<T> {
    return this.db.withTenant(tenantId, work);
  }

  /** Appends the record's event as the last statement and returns the projection that was hashed. */
  private async finish(client: PoolClient, tenantId: string, table: RecordTable, id: string): Promise<InsertResult> {
    await appendEvent(client, table, id, await this.eventIdOf(client, table, id));
    return { record: await this.mustOne(client, tenantId, table, id), created: true };
  }

  private async eventIdOf(client: PoolClient, table: RecordTable, id: string): Promise<string> {
    // `table` is one of the six RECORD_TABLES (a closed type), never caller input, so interpolating the identifier is safe.
    const { rows } = await client.query<{ ledger_event_id: string }>(`SELECT ledger_event_id::text AS ledger_event_id FROM ${table} WHERE id = $1`, [id]);
    return rows[0]!.ledger_event_id;
  }

  private async existing(client: PoolClient, tenantId: string, table: RecordTable, id: string): Promise<InsertResult> {
    return { record: await this.mustOne(client, tenantId, table, id), created: false };
  }

  /** A concurrent writer won the identity race between our look-up and our insert: return what it stored. */
  private async raced(client: PoolClient, tenantId: string, table: RecordTable, constraint: string, keys?: string[], identityKey?: string): Promise<InsertResult> {
    const { rows } = table === 'evaluations'
      ? await client.query<{ id: string }>(`SELECT id::text AS id FROM evaluations WHERE tenant_id = $1 AND identity_key = $2`, [tenantId, identityKey])
      : await client.query<{ id: string }>(
          `SELECT id::text AS id FROM report_captures WHERE tenant_id = $1 AND report_id = $2 AND text_sha256 = $3 AND poppler_version = $4`, [tenantId, ...keys!]);
    if (!rows[0]) throw toLedgerError(Object.assign(new Error('identity conflict'), { code: '23505', constraint }));
    return this.existing(client, tenantId, table, rows[0].id);
  }

  private async insertNote(client: PoolClient, tenantId: string, actor: string, body: string): Promise<string> {
    const id = newId();
    await client.query(
      `INSERT INTO event_notes (id, tenant_id, created_by, body, body_sha256) VALUES ($1, $2, $3, $4, encode(sha256(convert_to($4::text, 'UTF8')), 'hex'))`,
      [id, tenantId, actor, body],
    );
    return id;
  }

  private async one(client: PoolClient, tenantId: string, table: RecordTable, id: string): Promise<Projected | undefined> {
    const projection = (await loadProjections(client, table, [id])).get(id);
    // Row-level security already limits the read to the tenant; this is the second, independent check.
    return projection && projection.tenantId === tenantId ? (projection as Projected) : undefined;
  }

  private async mustOne(client: PoolClient, tenantId: string, table: RecordTable, id: string): Promise<Projected> {
    const record = await this.one(client, tenantId, table, id);
    if (!record) throw new Error('A record written in this transaction could not be read back.');
    return record;
  }

  private async many(client: PoolClient, tenantId: string, table: RecordTable, ids: string[]): Promise<Projected[]> {
    const loaded = await loadProjections(client, table, ids);
    return ids.map((id) => {
      const projection = loaded.get(id);
      if (!projection || projection.tenantId !== tenantId) throw new Error('A listed record could not be read back.');
      return projection as Projected;
    });
  }
}

/**
 * The current evaluation of each report (specification 4.5): the latest (`seq`) one that is ACTIVE. An evaluation is not active when its
 * last correction (the one with no child) is a retraction or a supersession; no corrections, or a last reinstatement, means active.
 * Uses `$1` for the tenant. Computed in one statement, so a list built from it is consistent.
 */
const CURRENT_EVALUATIONS_SQL = `
  SELECT DISTINCT ON (a.report_id) a.id
    FROM evaluations a
   WHERE a.tenant_id = $1
     AND NOT EXISTS (
       SELECT 1 FROM corrections c
        WHERE c.tenant_id = a.tenant_id AND c.evaluation_id = a.id AND c.kind IN ('retraction', 'supersession')
          AND NOT EXISTS (SELECT 1 FROM corrections n WHERE n.tenant_id = c.tenant_id AND n.previous_correction_id = c.id))
   ORDER BY a.report_id, a.seq DESC`;

/**
 * The key under which "the same evaluation" is recognised: what was evaluated (capture and acceptance), with which knowledge and
 * code, and how it came out. The hash is over canonical JSON of these fields only, so re-submitting the same inputs is idempotent.
 */
export function evaluationIdentityKey(input: EvaluationInput): string {
  return canonicalHash({
    v: 'evaluation-identity-v1', reportId: input.reportId, captureId: input.captureId, captureAcceptanceId: input.captureAcceptanceId,
    disposition: input.disposition, holdCode: input.holdCode, knowledgeSetId: input.knowledgeSetId, engineVersion: input.engineVersion, binding: input.binding,
  });
}
