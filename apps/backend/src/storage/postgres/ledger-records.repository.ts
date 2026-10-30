import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type { DisputeStatusValue } from '@telesphoros/shared-types';
import type { Page, PageRequest } from '../records';
import { Database } from '../../db/database';
import { LedgerStatus } from '../../ledger/ledger-status';
import { appendEvent, newId } from '../../ledger/ledger-writer';
import {
  DisputeChangedError,
  MergeAlreadyDecidedError,
  MergeRefusedError,
  PatientLinkUnverifiedError,
  StaleAcceptanceError,
  SourceChangedError,
  toLedgerError,
  type RecordTable,
} from '../../ledger/ledger-types';
import { loadProjections } from '../../ledger/projections';
import { canonicalHash } from '../../services/report-adapter/canonical-json';
import { CaptureDecisionRequestReusedError, DisputeRequestReusedError, LedgerRecordsRepository } from '../ledger-records.repository';
import type { ClinicianDecisionInput, ResultBasis } from '../clinician-decisions';
import { assertDecisionBasis, clinicianDecisionError, insertDecisionRow, resultBasis } from './clinician-decisions';
import type { ResultAcknowledgementInput } from '../result-acknowledgements';
import { insertCaptureProvenance, insertEvaluationProvenance } from './data-provenance';
import { assertAcknowledgementBasis, insertAcknowledgementRow, resultAcknowledgementError } from './result-acknowledgements';
import type {
  AcceptanceInput,
  CaptureInput,
  CorrectionInput,
  DisputeDecisionInput,
  DisputeInput,
  DisputeStatus,
  EvaluationCompletion,
  EvaluationInput,
  EvaluationReadContext,
  EvaluationState,
  EvaluationView,
  InsertResult,
  MergeDecisionInput,
  MergeProposalInput,
  MergeStatus,
  NoteRecord,
  PatientDecisionInput,
  PatientLinkStateValue,
  Projected,
  QuarantineEntry,
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
  /** `ledger` is the watch's shared state; a repository built without one (a test) never has a latch to obey. */
  constructor(
    private readonly db: Database,
    private readonly ledger: LedgerStatus = new LedgerStatus(),
  ) {
    super();
  }

  insertCapture(tenantId: string, actor: string, input: CaptureInput): Promise<InsertResult> {
    return this.write(tenantId, actor, async (client) => {
      // The report row is locked FOR SHARE for the rest of this transaction: a concurrent change to it waits for us, and one that
      // committed before is seen here. Then what the caller relied on is compared with what is there NOW.
      const locked = await client.query<{
        type: string;
        patient_id: string;
        sha256: string | null;
        object_version: string | null;
        storage_key: string | null;
        uploaded: boolean;
        uploaded_at: Date | null;
        deleted: boolean;
      }>(
        `SELECT type, patient_id::text AS patient_id, sha256, object_version, storage_key, uploaded_at IS NOT NULL AS uploaded, uploaded_at, deleted_at IS NOT NULL AS deleted
           FROM reports WHERE id = $1 AND tenant_id = $2 FOR SHARE`,
        [input.reportId, tenantId],
      );
      const report = locked.rows[0];
      const expected = input.expectedReport;
      if (
        !report ||
        report.deleted ||
        !report.uploaded ||
        report.type !== 'lab-pdf' ||
        report.patient_id !== expected.patientId ||
        report.sha256 !== expected.sha256 ||
        report.object_version !== expected.objectVersion ||
        report.storage_key !== expected.storageKey ||
        report.sha256 !== input.pdfSha256
      ) {
        throw new SourceChangedError();
      }
      const existing = await client.query<{ id: string }>(
        `SELECT id::text AS id FROM report_captures WHERE tenant_id = $1 AND report_id = $2 AND text_sha256 = $3 AND poppler_version = $4`,
        [tenantId, input.reportId, input.textSha256, input.popplerVersion],
      );
      if (existing.rows[0]) return this.existing(client, tenantId, 'report_captures', existing.rows[0].id);
      const id = newId();
      // No constraint is named on purpose. The table has a second unique key, the text object's key, which comes from the same
      // report, text and Poppler version. Naming only the identity key let a concurrent identical request fail on the second one (409 for
      // one caller). With none named, either conflict means "someone else just stored this"; `raced` then returns their record, or
      // fails if no record with this identity exists, so a conflict that is not a lost race is still an error, never a silent skip.
      const inserted = await client.query(
        `INSERT INTO report_captures (id, tenant_id, created_by, ledger_event_id, report_id, pdf_sha256, text_storage_key, text_sha256, text_scalars, poppler_version, runner)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         ON CONFLICT DO NOTHING RETURNING id`,
        [id, tenantId, actor, newId(), input.reportId, input.pdfSha256, input.textStorageKey, input.textSha256, input.textScalars, input.popplerVersion, input.runner],
      );
      if (inserted.rowCount === 0) return this.raced(client, tenantId, 'report_captures', 'report_captures_identity_uq', [input.reportId, input.textSha256, input.popplerVersion]);
      // Spec 020 E1a: the capture's provenance, in this same transaction and from the locked report row. A capture that cannot name its origin stores nothing.
      const provenanceId = await insertCaptureProvenance(client, tenantId, actor, id, {
        origin: input.origin,
        reportId: input.reportId,
        pdfSha256: input.pdfSha256,
        objectVersion: report.object_version!,
        receivedAt: report.uploaded_at!,
        runner: input.runner,
        popplerVersion: input.popplerVersion,
      });
      const stored = await this.finish(client, tenantId, 'report_captures', id);
      await this.finish(client, tenantId, 'data_provenance', provenanceId);
      return stored;
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

  insertPatientDecision(tenantId: string, actor: string, input: PatientDecisionInput): Promise<InsertResult> {
    return this.write(tenantId, actor, async (client) => {
      // One decision at a time per report, taken before anything is read: a shared row lock lets callers overlap, and the "same decision again" look-up below runs before
      // the ledger lock, so without this several identical callers each read "nothing new" and each insert. Held to commit, so a later caller's look-up sees this one's row.
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`patient-link:${tenantId}:${input.reportId}`]);
      // The report row is locked FOR SHARE for the rest of this transaction, then what the caller looked at is compared with what is there NOW.
      const locked = await client.query<{ patient_id: string; sha256: string | null; object_version: string | null; uploaded: boolean; deleted: boolean }>(
        `SELECT patient_id::text AS patient_id, sha256, object_version, uploaded_at IS NOT NULL AS uploaded, deleted_at IS NOT NULL AS deleted
           FROM reports WHERE id = $1 AND tenant_id = $2 FOR SHARE`,
        [input.reportId, tenantId],
      );
      const report = locked.rows[0];
      const expected = input.expectedReport;
      if (
        !report ||
        report.deleted ||
        !report.uploaded ||
        report.patient_id !== expected.patientId ||
        report.sha256 !== expected.sha256 ||
        report.object_version !== expected.objectVersion
      ) {
        throw new SourceChangedError();
      }
      // The same decision about the same file, again: nothing new to record.
      const newest = await client.query<{ id: string; decision: string; report_sha256: string; object_version: string; patient_id: string }>(
        `SELECT id::text AS id, decision, report_sha256, object_version, patient_id::text AS patient_id
           FROM report_patient_decisions WHERE tenant_id = $1 AND report_id = $2 ORDER BY seq DESC LIMIT 1`,
        [tenantId, input.reportId],
      );
      const last = newest.rows[0];
      if (
        last &&
        last.decision === input.decision &&
        last.report_sha256 === expected.sha256 &&
        last.object_version === expected.objectVersion &&
        last.patient_id === expected.patientId
      ) {
        return this.existing(client, tenantId, 'report_patient_decisions', last.id);
      }
      const id = newId();
      await client.query(
        `INSERT INTO report_patient_decisions (id, tenant_id, created_by, ledger_event_id, report_id, patient_id, report_sha256, object_version, decision, method, basis_code, identifier_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [
          id,
          tenantId,
          actor,
          newId(),
          input.reportId,
          expected.patientId,
          expected.sha256,
          expected.objectVersion,
          input.decision,
          input.method,
          input.basisCode ?? null,
          input.identifierId ?? null,
        ],
      );
      return this.finish(client, tenantId, 'report_patient_decisions', id);
    });
  }

  latestPatientDecision(tenantId: string, reportId: string): Promise<Projected | undefined> {
    return this.read(tenantId, async (client) => {
      const { rows } = await client.query<{ id: string }>(`SELECT id::text AS id FROM report_patient_decisions WHERE tenant_id = $1 AND report_id = $2 ORDER BY seq DESC LIMIT 1`, [
        tenantId,
        reportId,
      ]);
      return rows[0] ? this.one(client, tenantId, 'report_patient_decisions', rows[0].id) : undefined;
    });
  }

  patientLinkStates(tenantId: string, reportIds: string[]): Promise<Map<string, PatientLinkStateValue>> {
    return this.read(tenantId, (client) => this.linkStatesIn(client, tenantId, reportIds));
  }

  private async linkStatesIn(client: PoolClient, tenantId: string, reportIds: string[]): Promise<Map<string, PatientLinkStateValue>> {
    const { rows } = await client.query<{ report_id: string; state: PatientLinkStateValue }>(
      `SELECT r.id::text AS report_id,
                CASE WHEN d.id IS NULL OR NOT (${LINK_APPLIES}) THEN 'unverified' WHEN d.decision = 'verified' THEN 'verified' ELSE 'rejected' END AS state
           FROM reports r
           LEFT JOIN LATERAL (SELECT x.* FROM report_patient_decisions x WHERE x.tenant_id = r.tenant_id AND x.report_id = r.id ORDER BY x.seq DESC LIMIT 1) d ON true
          WHERE r.tenant_id = $1 AND r.id = ANY($2::uuid[])`,
      [tenantId, reportIds],
    );
    const found = new Map(rows.map((r) => [r.report_id, r.state]));
    return new Map(reportIds.map((id) => [id, found.get(id) ?? 'unverified']));
  }

  pageQuarantine(tenantId: string, page: PageRequest): Promise<Page<QuarantineEntry>> {
    return this.read(tenantId, async (client) => {
      // One statement for the count and the page. An evaluation is active unless its last correction (the one with no child) retracts or supersedes it.
      const { rows } = await client.query<{
        report_id: string | null;
        patient_id: string;
        basis_code: string | null;
        rejected_at: string;
        evaluation_ids: string[];
        total: number;
      }>(
        `WITH quarantined AS MATERIALIZED (
           SELECT r.id AS report_id, r.patient_id, d.basis_code, d.seq AS decision_seq,
                  to_char(d.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS rejected_at,
                  array_agg(e.id::text ORDER BY e.seq) AS evaluation_ids
             FROM reports r
             JOIN LATERAL (SELECT x.* FROM report_patient_decisions x WHERE x.tenant_id = r.tenant_id AND x.report_id = r.id ORDER BY x.seq DESC LIMIT 1) d ON true
             JOIN evaluations e ON e.tenant_id = r.tenant_id AND e.report_id = r.id
            WHERE r.tenant_id = $1 AND d.decision = 'rejected' AND (${LINK_APPLIES})
              AND NOT EXISTS (
                SELECT 1 FROM corrections c
                 WHERE c.tenant_id = e.tenant_id AND c.evaluation_id = e.id AND c.kind IN ('retraction', 'supersession')
                   AND NOT EXISTS (SELECT 1 FROM corrections n WHERE n.tenant_id = c.tenant_id AND n.previous_correction_id = c.id))
            GROUP BY r.id, r.patient_id, d.basis_code, d.seq, d.created_at),
         page AS (SELECT * FROM quarantined ORDER BY decision_seq, report_id LIMIT $2 OFFSET $3)
         SELECT page.report_id::text AS report_id, page.patient_id::text AS patient_id, page.basis_code, page.rejected_at, page.evaluation_ids, totals.total
           FROM (SELECT count(*)::int AS total FROM quarantined) totals LEFT JOIN page ON true ORDER BY page.decision_seq, page.report_id`,
        [tenantId, page.limit, page.offset],
      );
      return {
        items: rows.flatMap((r) =>
          r.report_id === null
            ? []
            : [{ reportId: r.report_id, patientId: r.patient_id, basisCode: r.basis_code, rejectedAt: r.rejected_at, activeEvaluationIds: r.evaluation_ids }],
        ),
        total: rows[0]!.total,
      };
    });
  }

  insertMergeProposal(tenantId: string, actor: string, input: MergeProposalInput): Promise<InsertResult> {
    return this.write(tenantId, actor, async (client) => {
      // One proposer at a time per pair and kind: without this, two calls read "nothing pending" together and both insert (the ledger lock comes only at
      // the end). The lock is held to commit, so the second call's check below sees the first call's proposal. Other pairs are not held up.
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`merge-proposal:${tenantId}:${input.kind}:${input.sourcePatientId}:${input.targetPatientId}`]);
      // The database's own rule, asked before anything is written so an impossible proposal is refused early. The decision is what is guaranteed.
      const refusal = await client.query<{ why: string | null }>(`SELECT patient_merge_refusal($1, $2, $3::uuid, $4::uuid) AS why`, [
        tenantId,
        input.kind,
        input.sourcePatientId,
        input.targetPatientId,
      ]);
      if (refusal.rows[0]!.why !== null) throw new MergeRefusedError(refusal.rows[0]!.why);
      const pending = await client.query(
        `SELECT 1 FROM patient_merge_proposals p
          WHERE p.tenant_id = $1 AND p.kind = $2 AND p.source_patient_id = $3 AND p.target_patient_id = $4
            AND NOT EXISTS (SELECT 1 FROM patient_merge_decisions d WHERE d.tenant_id = p.tenant_id AND d.proposal_id = p.id) LIMIT 1`,
        [tenantId, input.kind, input.sourcePatientId, input.targetPatientId],
      );
      if (pending.rowCount) throw new MergeRefusedError('proposal-pending');
      const id = newId();
      await client.query(
        `INSERT INTO patient_merge_proposals (id, tenant_id, created_by, ledger_event_id, kind, source_patient_id, target_patient_id, reason_code) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [id, tenantId, actor, newId(), input.kind, input.sourcePatientId, input.targetPatientId, input.reasonCode],
      );
      return this.finish(client, tenantId, 'patient_merge_proposals', id);
    });
  }

  insertMergeDecision(tenantId: string, actor: string, input: MergeDecisionInput): Promise<InsertResult> {
    return this.write(tenantId, actor, async (client) => {
      // Decisions on one source patient queue here, BEFORE the row takes its seq: patient_alias_edges keeps each source's newest decision by
      // seq, and the head lock that orders the ledger is taken only at the end. Held to commit, this makes "newest by seq" the last in the ledger.
      // A proposal is append-only, so its source cannot change under us; an unknown proposal takes no lock and is refused below as before.
      const proposal = await client.query<{ source: string }>(`SELECT source_patient_id::text AS source FROM patient_merge_proposals WHERE tenant_id = $1 AND id = $2`, [
        tenantId,
        input.proposalId,
      ]);
      if (proposal.rows[0]) {
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`merge-decision-source:${tenantId}:${proposal.rows[0].source}`]);
      }
      const existing = await client.query<{ id: string; decision: string }>(
        `SELECT id::text AS id, decision FROM patient_merge_decisions WHERE tenant_id = $1 AND proposal_id = $2`,
        [tenantId, input.proposalId],
      );
      if (existing.rows[0]) {
        if (existing.rows[0].decision !== input.decision) throw new MergeAlreadyDecidedError();
        return this.existing(client, tenantId, 'patient_merge_decisions', existing.rows[0].id);
      }
      const id = newId();
      const inserted = await client.query(
        `INSERT INTO patient_merge_decisions (id, tenant_id, created_by, ledger_event_id, proposal_id, decision) VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT ON CONSTRAINT patient_merge_decisions_proposal_uq DO NOTHING RETURNING id`,
        [id, tenantId, actor, newId(), input.proposalId, input.decision],
      );
      // A concurrent decision on the same proposal won the race between our look-up and our insert.
      if (inserted.rowCount === 0) throw new MergeAlreadyDecidedError();
      return this.finish(client, tenantId, 'patient_merge_decisions', id);
    });
  }

  findMerge(tenantId: string, proposalId: string): Promise<MergeStatus | undefined> {
    return this.read(tenantId, async (client) => {
      const { rows } = await client.query<{ decision_id: string | null }>(
        `SELECT d.id::text AS decision_id FROM patient_merge_proposals p
           LEFT JOIN patient_merge_decisions d ON d.tenant_id = p.tenant_id AND d.proposal_id = p.id WHERE p.tenant_id = $1 AND p.id = $2`,
        [tenantId, proposalId],
      );
      if (!rows[0]) return undefined;
      return this.mergeStatus(client, tenantId, proposalId, rows[0].decision_id);
    });
  }

  pageMerges(tenantId: string, page: PageRequest, status?: 'pending' | 'approved' | 'declined'): Promise<Page<MergeStatus>> {
    return this.read(tenantId, async (client) => {
      const { rows } = await client.query<{ id: string | null; decision_id: string | null; total: number }>(
        `WITH matching AS MATERIALIZED (SELECT p.id, p.seq, d.id AS decision_id FROM patient_merge_proposals p
          LEFT JOIN patient_merge_decisions d ON d.tenant_id = p.tenant_id AND d.proposal_id = p.id
          WHERE p.tenant_id = $1 AND ($2::text IS NULL OR CASE WHEN d.id IS NULL THEN 'pending' ELSE d.decision END = $2)),
          page AS (SELECT id, seq, decision_id FROM matching ORDER BY seq DESC LIMIT $3 OFFSET $4)
          SELECT page.id::text AS id, page.decision_id::text AS decision_id, totals.total
            FROM (SELECT count(*)::int AS total FROM matching) totals LEFT JOIN page ON true ORDER BY page.seq DESC`,
        [tenantId, status ?? null, page.limit, page.offset],
      );
      // The whole page's proposals and decisions in one statement each, not one lookup per row.
      const selected = rows.flatMap((r) => (r.id === null ? [] : [{ id: r.id, decisionId: r.decision_id }]));
      const proposals = await this.many(
        client,
        tenantId,
        'patient_merge_proposals',
        selected.map((r) => r.id),
      );
      const decisionIds = selected.flatMap((r) => (r.decisionId === null ? [] : [r.decisionId]));
      const decisions = new Map((await this.many(client, tenantId, 'patient_merge_decisions', decisionIds)).map((d) => [d.id, d]));
      const items: MergeStatus[] = selected.map((r, i) => {
        const decision = r.decisionId === null ? null : decisions.get(r.decisionId)!;
        return { proposal: proposals[i]!, decision, status: decision === null ? 'pending' : (decision.decision as 'approved' | 'declined') };
      });
      return { items, total: rows[0]!.total };
    });
  }

  private async mergeStatus(client: PoolClient, tenantId: string, proposalId: string, decisionId: string | null): Promise<MergeStatus> {
    const proposal = await this.mustOne(client, tenantId, 'patient_merge_proposals', proposalId);
    const decision = decisionId === null ? null : await this.mustOne(client, tenantId, 'patient_merge_decisions', decisionId);
    return { proposal, decision, status: decision === null ? 'pending' : (decision.decision as 'approved' | 'declined') };
  }

  /**
   * After the ledger lock is held (a patient-link decision appends under the same lock): the decision the evaluation relied on is still the
   * newest for the report, says `verified`, and was made about the file and patient the report has now. The report row is locked for the rest
   * of the transaction, so the file cannot change under the evaluation either.
   */
  private async assertVerifiedLink(client: PoolClient, tenantId: string, reportId: string, decisionId: string): Promise<void> {
    const { rows } = await client.query<{ id: string; decision: string; ok: boolean }>(
      `SELECT d.id::text AS id, d.decision,
              (d.report_sha256 = r.sha256 AND d.object_version = r.object_version AND d.patient_id = r.patient_id AND r.deleted_at IS NULL) AS ok
         FROM report_patient_decisions d JOIN reports r ON r.id = d.report_id AND r.tenant_id = d.tenant_id
        WHERE d.tenant_id = $1 AND d.report_id = $2 ORDER BY d.seq DESC LIMIT 1 FOR SHARE OF r`,
      [tenantId, reportId],
    );
    const newest = rows[0];
    if (!newest || newest.id !== decisionId || newest.decision !== 'verified' || !newest.ok) throw new PatientLinkUnverifiedError();
  }

  insertAcceptance(tenantId: string, actor: string, input: AcceptanceInput): Promise<InsertResult> {
    return this.write(tenantId, actor, async (client) => {
      if (input.request) {
        // Repeats of one retry identity queue here, so two at once cannot both miss the look-up and the second cannot leave a note behind.
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`capture-decision-request:${tenantId}:${actor}:${input.request.id}`]);
        const { rows } = await client.query<{ id: string; hash: string }>(
          `SELECT id::text AS id, creation_request_hash AS hash FROM capture_acceptances WHERE tenant_id = $1 AND created_by = $2 AND creation_request_id = $3`,
          [tenantId, actor, input.request.id],
        );
        if (rows[0]) {
          if (rows[0].hash !== input.request.hash) throw new CaptureDecisionRequestReusedError();
          return this.existing(client, tenantId, 'capture_acceptances', rows[0].id);
        }
      }
      // Decisions on one capture queue here, BEFORE the row takes its seq: "newest by seq" then means "last in the ledger", because this lock
      // is held until commit and the head lock is taken after it.
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`capture-decision:${tenantId}:${input.captureId}`]);
      const id = newId();
      const noteId = input.note === undefined ? null : await this.insertNote(client, tenantId, actor, input.note);
      await client.query(
        `INSERT INTO capture_acceptances (id, tenant_id, created_by, ledger_event_id, capture_id, decision, text_sha256, poppler_version, note_id,
                                          creation_request_id, creation_request_hash)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [id, tenantId, actor, newId(), input.captureId, input.decision, input.textSha256, input.popplerVersion, noteId, input.request?.id ?? null, input.request?.hash ?? null],
      );
      return this.finish(client, tenantId, 'capture_acceptances', id);
    });
  }

  latestAcceptance(tenantId: string, captureId: string): Promise<Projected | undefined> {
    return this.read(tenantId, async (client) => {
      const { rows } = await client.query<{ id: string }>(`SELECT id::text AS id FROM capture_acceptances WHERE tenant_id = $1 AND capture_id = $2 ORDER BY seq DESC LIMIT 1`, [
        tenantId,
        captureId,
      ]);
      return rows[0] ? this.one(client, tenantId, 'capture_acceptances', rows[0].id) : undefined;
    });
  }

  insertEvaluation(tenantId: string, actor: string, input: EvaluationInput, completion?: EvaluationCompletion): Promise<InsertResult> {
    return this.write(tenantId, actor, async (client) => {
      // H3: the worker must hold the request's job before anything is written. The lock this takes on the job keeps another worker from claiming it again
      // until COMMIT, and the completion's own check (migration 0051) asks again; a refusal (EJ001) rolls the evaluation back with it.
      if (completion) await client.query('SELECT evaluation_job_fence($1, $2)', [completion.jobId, completion.workerId]);
      const result = await this.storeEvaluation(client, tenantId, actor, input);
      if (completion) {
        await client.query(`INSERT INTO evaluation_request_completions (request_id, tenant_id, evaluation_id, job_id, worker_id) VALUES ($1, $2, $3, $4, $5)`, [
          completion.requestId,
          tenantId,
          result.record.id,
          completion.jobId,
          completion.workerId,
        ]);
      }
      return result;
    });
  }

  private async storeEvaluation(client: PoolClient, tenantId: string, actor: string, input: EvaluationInput): Promise<InsertResult> {
    const identityKey = evaluationIdentityKey(input);
    const existing = await client.query<{ id: string }>(`SELECT id::text AS id FROM evaluations WHERE tenant_id = $1 AND identity_key = $2`, [tenantId, identityKey]);
    if (existing.rows[0]) return this.existing(client, tenantId, 'evaluations', existing.rows[0].id);
    const id = newId();
    const inserted = await client.query(
      `INSERT INTO evaluations (id, tenant_id, created_by, ledger_event_id, patient_id, report_id, capture_id, capture_acceptance_id, disposition, hold_code,
                                  binding, knowledge_set_id, engine_version, gene_inputs, occurrences, identity_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, $13, $14::jsonb, $15::jsonb, $16)
         ON CONFLICT ON CONSTRAINT evaluations_identity_uq DO NOTHING RETURNING id`,
      [
        id,
        tenantId,
        actor,
        newId(),
        input.patientId,
        input.reportId,
        input.captureId,
        input.captureAcceptanceId,
        input.disposition,
        input.holdCode,
        JSON.stringify(input.binding),
        input.knowledgeSetId,
        input.engineVersion,
        JSON.stringify(input.geneInputs),
        JSON.stringify(input.occurrences),
        identityKey,
      ],
    );
    if (inserted.rowCount === 0) return this.raced(client, tenantId, 'evaluations', 'evaluations_identity_uq', undefined, identityKey);
    let ordinal = 0;
    for (const result of input.results) {
      const citation = 'citation' in result ? result.citation : null;
      await client.query(
        `INSERT INTO evaluation_results (tenant_id, evaluation_id, ordinal, drug, genes, outcome, reason_code, strength, citation, guideline_id, guideline_version,
                                           recommendation_text, implication, gene_evidence)
           VALUES ($1, $2, $3, $4, $5::text[], $6, $7, $8, $9::jsonb, $10, $11, $12, $13, $14::jsonb)`,
        [
          tenantId,
          id,
          ordinal++,
          result.drug,
          result.genes,
          result.outcome,
          'reasonCode' in result ? result.reasonCode : null,
          'strength' in result ? result.strength : null,
          citation ? JSON.stringify(citation) : null,
          citation?.guidelineId ?? null,
          citation?.guidelineVersion ?? null,
          'recommendationText' in result ? result.recommendationText : null,
          'implication' in result ? result.implication : null,
          JSON.stringify(result.geneStates),
        ],
      );
    }
    for (const state of input.geneStates) {
      await client.query(
        `INSERT INTO evaluation_gene_states (tenant_id, evaluation_id, gene, state, phenotype, diplotype, activity_score, reason_code)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [tenantId, id, state.gene, state.state, state.phenotype, state.diplotype, state.activityScore, state.reasonCode],
      );
    }
    // Spec 020 E1a: the evaluation's provenance, in this same transaction. An evaluation that cannot name its origin stores nothing.
    const provenanceId = await insertEvaluationProvenance(client, tenantId, actor, id, {
      origin: input.origin,
      captureId: input.captureId,
      captureAcceptanceId: input.captureAcceptanceId,
      engineVersion: input.engineVersion,
      knowledgeSetId: input.knowledgeSetId,
    });
    const stored = await this.finish(client, tenantId, 'evaluations', id);
    await this.finish(client, tenantId, 'data_provenance', provenanceId);
    // Capture decisions append under this same lock. A fresh statement sees any decision committed before we acquired it.
    if (input.captureAcceptanceId !== null) await this.assertCurrentAcceptance(client, tenantId, input.captureId, input.captureAcceptanceId);
    if (input.patientLinkDecisionId !== undefined) await this.assertVerifiedLink(client, tenantId, input.reportId, input.patientLinkDecisionId);
    // The append above took the tenant's ledger head lock and keeps it until COMMIT. Raising or deciding a dispute also appends, so it
    // needs the same lock: every dispute change is either committed before we got the lock (and this separate statement, a new
    // snapshot under READ COMMITTED, sees it) or queued behind us (and is ordered after this evaluation).
    if (input.disposition === 'evaluated') await this.assertDisputeBasis(client, tenantId, input.disputeBasis ?? []);
    return stored;
  }

  /** The ids of the disputes in force (open, or decided `upheld`) in the tenant. */
  private async activeDisputeIds(client: PoolClient, tenantId: string): Promise<string[]> {
    const { rows } = await client.query<{ id: string }>(
      `SELECT d.id::text AS id FROM cell_disputes d
         LEFT JOIN cell_dispute_decisions x ON x.dispute_id = d.id AND x.tenant_id = d.tenant_id
        WHERE d.tenant_id = $1 AND (x.id IS NULL OR x.decision = 'upheld')`,
      [tenantId],
    );
    return rows.map((r) => r.id);
  }

  private async assertCurrentAcceptance(client: PoolClient, tenantId: string, captureId: string, acceptanceId: string): Promise<void> {
    const { rows } = await client.query<{ id: string; decision: string }>(
      `SELECT id::text AS id, decision FROM capture_acceptances
        WHERE tenant_id = $1 AND capture_id = $2 ORDER BY seq DESC LIMIT 1`,
      [tenantId, captureId],
    );
    if (!rows[0] || rows[0].id !== acceptanceId || rows[0].decision !== 'accepted') throw new StaleAcceptanceError();
  }

  /**
   * Its own statement, never part of the append: that is what gives it a fresh snapshot after the lock is held. A dispute that LEFT the
   * set since the caller looked (it was dismissed) is harmless: the overlay was only more cautious than needed.
   */
  private async assertDisputeBasis(client: PoolClient, tenantId: string, basis: readonly string[]): Promise<void> {
    const known = new Set(basis);
    if ((await this.activeDisputeIds(client, tenantId)).some((id) => !known.has(id))) throw new DisputeChangedError();
  }

  findEvaluation(tenantId: string, id: string): Promise<Projected | undefined> {
    return this.read(tenantId, (client) => this.one(client, tenantId, 'evaluations', id));
  }

  listEvaluations(tenantId: string, filter: { reportId?: string; patientId?: string; current?: boolean }, page: PageRequest): Promise<Page<Projected>> {
    return this.read(tenantId, async (client) => {
      // Count and page use ONE statement snapshot, including when the requested page is empty.
      const { rows } = await client.query<{ id: string | null; total: number }>(
        `WITH matching AS MATERIALIZED (SELECT e.id, e.seq FROM evaluations e
          WHERE e.tenant_id = $1 AND ($2::uuid IS NULL OR e.report_id = $2::uuid) AND ($3::uuid IS NULL OR e.patient_id IN (SELECT patient_group_ids($1, $3::uuid)))
            AND (NOT $4::boolean OR e.id IN (${CURRENT_EVALUATIONS_SQL}))),
          page AS (SELECT id, seq FROM matching ORDER BY seq LIMIT $5 OFFSET $6)
          SELECT page.id::text AS id, totals.total FROM (SELECT count(*)::int AS total FROM matching) totals
            LEFT JOIN page ON true ORDER BY page.seq`,
        [tenantId, filter.reportId ?? null, filter.patientId ?? null, filter.current === true, page.limit, page.offset],
      );
      return {
        items: await this.many(
          client,
          tenantId,
          'evaluations',
          rows.flatMap((r) => (r.id === null ? [] : [r.id])),
        ),
        total: rows[0]!.total,
      };
    });
  }

  evaluationContexts(tenantId: string, evaluationIds: string[]): Promise<Map<string, EvaluationReadContext>> {
    if (evaluationIds.length === 0) return Promise.resolve(new Map());
    return this.read(tenantId, (client) => this.contextsIn(client, tenantId, evaluationIds));
  }

  private async contextsIn(client: PoolClient, tenantId: string, evaluationIds: string[]): Promise<Map<string, EvaluationReadContext>> {
    const { rows } = await client.query<{ id: string; acceptance_id: string | null; decision: 'accepted' | 'rejected' | null; latest_id: string | null }>(
      `WITH selected AS MATERIALIZED (SELECT id, capture_id, capture_acceptance_id FROM evaluations WHERE tenant_id = $1 AND id = ANY($2::uuid[])),
          latest AS (SELECT DISTINCT ON (capture_id) capture_id, id FROM capture_acceptances
            WHERE tenant_id = $1 AND capture_id IN (SELECT capture_id FROM selected) ORDER BY capture_id, seq DESC)
          SELECT e.id::text AS id, a.id::text AS acceptance_id, a.decision, l.id::text AS latest_id FROM selected e
            LEFT JOIN capture_acceptances a ON a.id = e.capture_acceptance_id AND a.tenant_id = $1 AND a.capture_id = e.capture_id
            LEFT JOIN latest l ON l.capture_id = e.capture_id`,
      [tenantId, evaluationIds],
    );
    const contexts = new Map<string, EvaluationReadContext>(
      rows.map((r) => [
        r.id,
        {
          acceptance: r.acceptance_id === null ? null : { id: r.acceptance_id, decision: r.decision!, current: r.acceptance_id === r.latest_id },
          corrections: [],
        },
      ]),
    );
    if (contexts.size === 0) return contexts;
    const corrections = await client.query<{ id: string }>(`SELECT id::text AS id FROM corrections WHERE tenant_id = $1 AND evaluation_id = ANY($2::uuid[]) ORDER BY seq`, [
      tenantId,
      [...contexts.keys()],
    ]);
    for (const correction of await this.many(
      client,
      tenantId,
      'corrections',
      corrections.rows.map((r) => r.id),
    )) {
      contexts.get(correction.evaluationId as string)!.corrections.push(correction);
    }
    return contexts;
  }

  currentEvaluationIds(tenantId: string, reportIds: string[]): Promise<Map<string, string | null>> {
    return this.read(tenantId, (client) => this.currentIdsIn(client, tenantId, reportIds));
  }

  private async currentIdsIn(client: PoolClient, tenantId: string, reportIds: string[]): Promise<Map<string, string | null>> {
    const { rows } = await client.query<{ report_id: string; id: string }>(
      `SELECT e.report_id::text AS report_id, e.id::text AS id FROM evaluations e WHERE e.id IN (${currentEvaluationsSql('$2')}) AND e.report_id = ANY($2::uuid[])`,
      [tenantId, reportIds],
    );
    const found = new Map(rows.map((r) => [r.report_id, r.id]));
    return new Map(reportIds.map((reportId) => [reportId, found.get(reportId) ?? null]));
  }

  evaluationView(tenantId: string, id: string): Promise<EvaluationView | undefined> {
    return this.read(tenantId, async (client) => {
      const record = await this.one(client, tenantId, 'evaluations', id);
      return record ? this.viewIn(client, tenantId, record) : undefined;
    });
  }

  viewOfEvaluation(tenantId: string, record: Projected): Promise<EvaluationView> {
    return this.read(tenantId, (client) => this.viewIn(client, tenantId, record));
  }

  /** Every statement runs in the caller's transaction, so one read costs one checkout, one BEGIN and one COMMIT however many facts it gathers. */
  private async viewIn(client: PoolClient, tenantId: string, record: Projected): Promise<EvaluationView> {
    const reportId = record.reportId as string;
    const context = (await this.contextsIn(client, tenantId, [record.id])).get(record.id);
    if (!context) throw new Error('An evaluation read in this transaction has no context.');
    const currentId = (await this.currentIdsIn(client, tenantId, [reportId])).get(reportId) ?? null;
    const patientLink = (await this.linkStatesIn(client, tenantId, [reportId])).get(reportId) ?? 'unverified';
    return { record, context, current: currentId === record.id, patientLink, activeDisputes: await this.activeDisputeCountIn(client, tenantId) };
  }

  activeDisputeCount(tenantId: string): Promise<number> {
    return this.read(tenantId, (client) => this.activeDisputeCountIn(client, tenantId));
  }

  /** A dispute is active unless its one final decision dismisses it (an open dispute has no decision), as `disputeStatuses` derives it. */
  private async activeDisputeCountIn(client: PoolClient, tenantId: string): Promise<number> {
    const { rows } = await client.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM cell_disputes d
         LEFT JOIN cell_dispute_decisions x ON x.dispute_id = d.id AND x.tenant_id = d.tenant_id
        WHERE d.tenant_id = $1 AND x.decision IS DISTINCT FROM 'dismissed'`,
      [tenantId],
    );
    return rows[0]!.n;
  }

  insertCorrection(tenantId: string, actor: string, input: CorrectionInput): Promise<InsertResult> {
    return this.write(tenantId, actor, async (client) => {
      const id = newId();
      const noteId = input.note === undefined ? null : await this.insertNote(client, tenantId, actor, input.note);
      // report_id is copied from the evaluation inside the statement, so a caller cannot name a different report.
      await client
        .query(
          `INSERT INTO corrections (id, tenant_id, created_by, ledger_event_id, evaluation_id, report_id, kind, reason_code, previous_correction_id, replacement_evaluation_id, note_id)
         SELECT $1, $2, $3, $4, e.id, e.report_id, $6, $7, $8::uuid, $9::uuid, $10::uuid FROM evaluations e WHERE e.id = $5::uuid AND e.tenant_id = $2`,
          [id, tenantId, actor, newId(), input.evaluationId, input.kind, input.reasonCode, input.previousCorrectionId ?? null, input.replacementEvaluationId ?? null, noteId],
        )
        .then((result) => {
          if (result.rowCount === 0) throw toLedgerError(Object.assign(new Error('evaluation not found'), { code: '23503', constraint: 'corrections_evaluation_fk' }));
        });
      return this.finish(client, tenantId, 'corrections', id);
    });
  }

  listCorrections(tenantId: string, evaluationId: string): Promise<Projected[]> {
    return this.read(tenantId, async (client) => {
      const { rows } = await client.query<{ id: string }>(`SELECT id::text AS id FROM corrections WHERE tenant_id = $1 AND evaluation_id = $2 ORDER BY seq`, [
        tenantId,
        evaluationId,
      ]);
      return this.many(
        client,
        tenantId,
        'corrections',
        rows.map((r) => r.id),
      );
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
      if (input.request) {
        // Repeats of one retry identity queue here, so two at once cannot both miss the look-up and the second cannot leave a note behind.
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`dispute-request:${tenantId}:${actor}:${input.request.id}`]);
        const { rows } = await client.query<{ id: string; hash: string }>(
          `SELECT id::text AS id, creation_request_hash AS hash FROM cell_disputes WHERE tenant_id = $1 AND created_by = $2 AND creation_request_id = $3`,
          [tenantId, actor, input.request.id],
        );
        if (rows[0]) {
          if (rows[0].hash !== input.request.hash) throw new DisputeRequestReusedError();
          return this.existing(client, tenantId, 'cell_disputes', rows[0].id);
        }
      }
      const id = newId();
      const noteId = await this.insertNote(client, tenantId, actor, input.note);
      await client.query(
        `INSERT INTO cell_disputes (id, tenant_id, created_by, ledger_event_id, guideline_id, guideline_version, guideline_content_sha256, locator_table, locator_row, locator_column, note_id,
                                    creation_request_id, creation_request_hash)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
        [
          id,
          tenantId,
          actor,
          newId(),
          input.guidelineId,
          input.guidelineVersion,
          input.guidelineContentSha256,
          input.locator.table,
          input.locator.row,
          input.locator.column ?? null,
          noteId,
          input.request?.id ?? null,
          input.request?.hash ?? null,
        ],
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
    return this.read(tenantId, (client) => this.disputeStatuses(client, tenantId));
  }

  pageDisputes(tenantId: string, page: PageRequest, status?: DisputeStatusValue): Promise<Page<DisputeStatus>> {
    return this.read(tenantId, async (client) => {
      const { rows } = await client.query<{ id: string | null; decision_id: string | null; total: number }>(
        `WITH matching AS MATERIALIZED (SELECT d.id, d.seq, x.id AS decision_id FROM cell_disputes d
          LEFT JOIN cell_dispute_decisions x ON x.dispute_id = d.id AND x.tenant_id = d.tenant_id
          WHERE d.tenant_id = $1 AND ($2::text IS NULL OR COALESCE(x.decision, 'open') = $2)),
          page AS (SELECT id, seq, decision_id FROM matching ORDER BY seq LIMIT $3 OFFSET $4)
          SELECT page.id::text AS id, page.decision_id::text AS decision_id, totals.total
            FROM (SELECT count(*)::int AS total FROM matching) totals LEFT JOIN page ON true ORDER BY page.seq`,
        [tenantId, status ?? null, page.limit, page.offset],
      );
      const selected = rows.flatMap((r) => (r.id === null ? [] : [{ id: r.id, decision_id: r.decision_id }]));
      return { items: await this.loadDisputeStatuses(client, tenantId, selected), total: rows[0]!.total };
    });
  }

  findDispute(tenantId: string, id: string): Promise<DisputeStatus | undefined> {
    return this.read(tenantId, async (client) => (await this.disputeStatuses(client, tenantId, id))[0]);
  }

  cellEvaluationCandidates(tenantId: string, cell: DisputeInput, afterSeq: string, limit: number): Promise<Projected[]> {
    return this.read(tenantId, async (client) => {
      const { rows } = await client.query<{ id: string }>(
        `SELECT e.id::text AS id FROM evaluations e
          WHERE e.tenant_id = $1 AND e.seq > $2::bigint AND EXISTS (
            SELECT 1 FROM evaluation_results r
             WHERE r.tenant_id = $1 AND r.evaluation_id = e.id
               AND r.guideline_id = $3 AND r.guideline_version = $4
               AND r.citation->'locator'->>'table' = $5 AND r.citation->'locator'->>'row' = $6
               AND (r.citation->'locator'->>'column') IS NOT DISTINCT FROM $7::text)
          ORDER BY e.seq LIMIT $8`,
        [tenantId, afterSeq, cell.guidelineId, cell.guidelineVersion, cell.locator.table, cell.locator.row, cell.locator.column ?? null, limit],
      );
      return this.many(
        client,
        tenantId,
        'evaluations',
        rows.map((r) => r.id),
      );
    });
  }

  private async disputeStatuses(client: PoolClient, tenantId: string, only?: string): Promise<DisputeStatus[]> {
    const disputes = await client.query<{ id: string; decision_id: string | null }>(
      `SELECT d.id::text AS id, x.id::text AS decision_id FROM cell_disputes d
         LEFT JOIN cell_dispute_decisions x ON x.dispute_id = d.id AND x.tenant_id = d.tenant_id
        WHERE d.tenant_id = $1 AND ($2::uuid IS NULL OR d.id = $2::uuid) ORDER BY d.seq`,
      [tenantId, only ?? null],
    );
    return this.loadDisputeStatuses(client, tenantId, disputes.rows);
  }

  private async loadDisputeStatuses(client: PoolClient, tenantId: string, rows: { id: string; decision_id: string | null }[]): Promise<DisputeStatus[]> {
    const disputeRows = await this.many(
      client,
      tenantId,
      'cell_disputes',
      rows.map((r) => r.id),
    );
    const decisionIds = rows.flatMap((r) => (r.decision_id ? [r.decision_id] : []));
    const decisions = new Map((await this.many(client, tenantId, 'cell_dispute_decisions', decisionIds)).map((d) => [d.id, d]));
    return rows.map((row, index) => {
      const decision = row.decision_id ? decisions.get(row.decision_id)! : null;
      return { dispute: disputeRows[index]!, status: decision ? (decision.decision as 'upheld' | 'dismissed') : 'open', decision };
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

  // ---- clinician result decisions (spec 006 D01b; the SQL and the write order are in clinician-decisions.ts) -------------------------------

  async insertClinicianDecision(tenantId: string, actor: string, input: ClinicianDecisionInput): Promise<InsertResult> {
    try {
      return await this.write(tenantId, actor, async (client) => {
        const row = await insertDecisionRow(client, tenantId, actor, input, (body) => this.insertNote(client, tenantId, actor, body));
        if ('replayOf' in row) return this.existing(client, tenantId, 'clinician_result_decisions', row.replayOf);
        const stored = await this.finish(client, tenantId, 'clinician_result_decisions', row.inserted);
        // The append above holds the tenant's head lock until COMMIT; this separate statement sees every basis change committed before it.
        await assertDecisionBasis(client, tenantId, input.resultId);
        return stored;
      });
    } catch (error) {
      throw clinicianDecisionError(error);
    }
  }

  clinicianDecisionHistory(tenantId: string, resultId: string): Promise<{ basis: ResultBasis; entries: Projected[] } | undefined> {
    return this.read(tenantId, async (client) => {
      const basis = await resultBasis(client, tenantId, resultId);
      if (!basis) return undefined;
      const { rows } = await client.query<{ id: string }>(`SELECT id::text AS id FROM clinician_result_decisions WHERE tenant_id = $1 AND result_id = $2 ORDER BY seq`, [
        tenantId,
        resultId,
      ]);
      return {
        basis,
        entries: await this.many(
          client,
          tenantId,
          'clinician_result_decisions',
          rows.map((r) => r.id),
        ),
      };
    });
  }

  // ---- result acknowledgements (spec 019 D02a; the SQL and the write order are in result-acknowledgements.ts) -------------------------------

  async insertResultAcknowledgement(tenantId: string, actor: string, input: ResultAcknowledgementInput): Promise<InsertResult> {
    try {
      return await this.write(tenantId, actor, async (client) => {
        const row = await insertAcknowledgementRow(client, tenantId, actor, input);
        if ('replayOf' in row) return this.existing(client, tenantId, 'result_acknowledgements', row.replayOf);
        const stored = await this.finish(client, tenantId, 'result_acknowledgements', row.inserted);
        // The append above holds the tenant's head lock until COMMIT; this separate statement sees every basis change committed before it.
        await assertAcknowledgementBasis(client, tenantId, input);
        return stored;
      });
    } catch (error) {
      throw resultAcknowledgementError(error);
    }
  }

  resultAcknowledgements(tenantId: string, resultId: string): Promise<{ basis: ResultBasis; entries: Projected[] } | undefined> {
    return this.read(tenantId, async (client) => {
      const basis = await resultBasis(client, tenantId, resultId);
      if (!basis) return undefined;
      const { rows } = await client.query<{ id: string }>(`SELECT id::text AS id FROM result_acknowledgements WHERE tenant_id = $1 AND result_id = $2 ORDER BY seq`, [
        tenantId,
        resultId,
      ]);
      return {
        basis,
        entries: await this.many(
          client,
          tenantId,
          'result_acknowledgements',
          rows.map((r) => r.id),
        ),
      };
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
    const { projection } = await appendEvent(this.ledger, tenantId, client, table, id, await this.eventIdOf(client, table, id));
    // Not loaded again: the append has just read and hashed it, and loading it once more would run while the tenant's head lock is held.
    // Row-level security already limits the read to the tenant; this is the second, independent check (as in `one`).
    if (projection.tenantId !== tenantId) throw new Error('A record written in this transaction could not be read back.');
    return { record: projection as Projected, created: true };
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
    const { rows } =
      table === 'evaluations'
        ? await client.query<{ id: string }>(`SELECT id::text AS id FROM evaluations WHERE tenant_id = $1 AND identity_key = $2`, [tenantId, identityKey])
        : await client.query<{ id: string }>(`SELECT id::text AS id FROM report_captures WHERE tenant_id = $1 AND report_id = $2 AND text_sha256 = $3 AND poppler_version = $4`, [
            tenantId,
            ...keys!,
          ]);
    if (!rows[0]) throw toLedgerError(Object.assign(new Error('identity conflict'), { code: '23505', constraint }));
    return this.existing(client, tenantId, table, rows[0].id);
  }

  private async insertNote(client: PoolClient, tenantId: string, actor: string, body: string): Promise<string> {
    const id = newId();
    await client.query(`INSERT INTO event_notes (id, tenant_id, created_by, body, body_sha256) VALUES ($1, $2, $3, $4, encode(sha256(convert_to($4::text, 'UTF8')), 'hex'))`, [
      id,
      tenantId,
      actor,
      body,
    ]);
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
 * The newest decision `d` about the report `r` still applies: it names the file (hash and storage version) and the patient the report has now. A decision about an
 * earlier file leaves the report unverified, not quarantined.
 */
const LINK_APPLIES = `d.report_sha256 = r.sha256 AND d.object_version = r.object_version AND d.patient_id = r.patient_id`;

/**
 * The current evaluation of each report (specification 4.5, amended in section 22): the NEWEST (`seq`) evaluation of the report, if it is
 * ACTIVE, and otherwise none. An older active evaluation is never promoted when the newest is retracted: a retraction says "do not rely on
 * this", and nobody has said the older one is what to rely on instead. An evaluation is not active when its last correction (the one with
 * no child) is a retraction or a supersession; no corrections, or a last reinstatement, means active.
 * Uses `$1` for the tenant. Computed in one statement, so a list built from it is consistent.
 * With `reportsParam` (the name of a uuid[] parameter, e.g. `$2`) only those reports are looked at: the newest evaluation of a report is the same
 * whichever other reports are read, so the answer for them is unchanged, but the work no longer grows with every report the tenant has.
 */
const currentEvaluationsSql = (reportsParam?: string) => `
  SELECT newest.id
    FROM (SELECT DISTINCT ON (a.report_id) a.id, a.tenant_id, a.report_id
            FROM evaluations a
           WHERE a.tenant_id = $1${reportsParam ? ` AND a.report_id = ANY(${reportsParam}::uuid[])` : ''}
           ORDER BY a.report_id, a.seq DESC) newest
   WHERE NOT EXISTS (
     -- M2.1c-1: a report whose patient link was rejected for the file it holds now is quarantined, and nothing on it is current.
     SELECT 1 FROM reports r
       JOIN LATERAL (SELECT x.* FROM report_patient_decisions x WHERE x.tenant_id = r.tenant_id AND x.report_id = r.id ORDER BY x.seq DESC LIMIT 1) d ON true
      WHERE r.id = newest.report_id AND r.tenant_id = newest.tenant_id AND d.decision = 'rejected' AND (${LINK_APPLIES}))
   AND NOT EXISTS (
     SELECT 1 FROM corrections c
      WHERE c.tenant_id = newest.tenant_id AND c.evaluation_id = newest.id AND c.kind IN ('retraction', 'supersession')
        AND NOT EXISTS (SELECT 1 FROM corrections n WHERE n.tenant_id = c.tenant_id AND n.previous_correction_id = c.id))`;
const CURRENT_EVALUATIONS_SQL = currentEvaluationsSql();

/**
 * The key under which "the same evaluation" is recognised: what was evaluated (capture and acceptance), with which knowledge and
 * code, and how it came out. The hash is over canonical JSON of these fields only, so re-submitting the same inputs is idempotent.
 */
export function evaluationIdentityKey(input: EvaluationInput): string {
  return canonicalHash({
    v: 'evaluation-identity-v1',
    reportId: input.reportId,
    captureId: input.captureId,
    captureAcceptanceId: input.captureAcceptanceId,
    disposition: input.disposition,
    holdCode: input.holdCode,
    knowledgeSetId: input.knowledgeSetId,
    engineVersion: input.engineVersion,
    binding: input.binding,
  });
}
