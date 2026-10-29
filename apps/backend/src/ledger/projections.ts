import { canonicalHash } from '../services/report-adapter/canonical-json';
import { PROJECTION_VERSION, type RecordTable } from './ledger-types';

/** Anything with a pg-style `query`: a client inside a transaction, or a pool. */
export interface Queryable {
  query<R = Record<string, unknown>>(text: string, values?: unknown[]): Promise<{ rows: R[] }>;
}

/**
 * THE projection of each stored record: the one object that is hashed into its ledger event. The writer and the verifier both load
 * rows through `loadProjections`, so they cannot drift apart. A projection contains every column of the row as stored, in a fixed
 * encoding (the specification, section 6.2, lists it):
 *
 *   uuid       lower-case text            timestamptz   `YYYY-MM-DD"T"HH24:MI:SS.US"Z"` in UTC (microseconds; JavaScript dates would lose them)
 *   bigint     decimal STRING              numeric       text exactly as stored ("1.50")
 *   integer    JSON number                 text[]        array of strings, in stored order
 *   jsonb      canonicalized (keys sorted)  free text     NOT included: replaced by {id, bodySha256} of its note
 *
 * Children of an evaluation are ordered deterministically in code (results by `ordinal`, gene states by gene symbol, compared as
 * UTF-16 code units), never by the database's collation.
 */
const UTC = (column: string) => `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

export type Projection = Record<string, unknown>;

type Row = Record<string, unknown>;

interface Loader {
  sql: string;
  project: (row: Row) => Projection;
}

const note = (id: unknown, digest: unknown) => (id === null || id === undefined ? null : { id, bodySha256: digest });
const common = (r: Row) => ({
  version: PROJECTION_VERSION,
  id: r.id,
  tenantId: r.tenant_id,
  seq: r.seq,
  createdBy: r.created_by,
  createdAt: r.created_at,
  ledgerEventId: r.ledger_event_id,
});

const LOADERS: Record<Exclude<RecordTable, 'evaluations'>, Loader> = {
  report_captures: {
    sql: `SELECT id::text AS id, tenant_id, seq::text AS seq, created_by, ${UTC('created_at')} AS created_at, ledger_event_id::text AS ledger_event_id,
                 report_id::text AS report_id, pdf_sha256, text_storage_key, text_sha256, text_scalars, poppler_version, runner
            FROM report_captures WHERE id = ANY($1::uuid[])`,
    project: (r) => ({
      kind: 'capture',
      ...common(r),
      reportId: r.report_id,
      pdfSha256: r.pdf_sha256,
      textStorageKey: r.text_storage_key,
      textSha256: r.text_sha256,
      textScalars: r.text_scalars,
      popplerVersion: r.poppler_version,
      runner: r.runner,
    }),
  },
  capture_acceptances: {
    sql: `SELECT a.id::text AS id, a.tenant_id, a.seq::text AS seq, a.created_by, ${UTC('a.created_at')} AS created_at, a.ledger_event_id::text AS ledger_event_id,
                 a.capture_id::text AS capture_id, a.decision, a.text_sha256, a.poppler_version, n.id::text AS note_id, n.body_sha256 AS note_digest
            FROM capture_acceptances a LEFT JOIN event_notes n ON n.id = a.note_id AND n.tenant_id = a.tenant_id WHERE a.id = ANY($1::uuid[])`,
    project: (r) => ({
      kind: 'capture-decision',
      ...common(r),
      captureId: r.capture_id,
      decision: r.decision,
      textSha256: r.text_sha256,
      popplerVersion: r.poppler_version,
      note: note(r.note_id, r.note_digest),
    }),
  },
  corrections: {
    sql: `SELECT c.id::text AS id, c.tenant_id, c.seq::text AS seq, c.created_by, ${UTC('c.created_at')} AS created_at, c.ledger_event_id::text AS ledger_event_id,
                 c.evaluation_id::text AS evaluation_id, c.report_id::text AS report_id, c.kind, c.reason_code,
                 c.previous_correction_id::text AS previous_correction_id, c.replacement_evaluation_id::text AS replacement_evaluation_id,
                 n.id::text AS note_id, n.body_sha256 AS note_digest
            FROM corrections c LEFT JOIN event_notes n ON n.id = c.note_id AND n.tenant_id = c.tenant_id WHERE c.id = ANY($1::uuid[])`,
    project: (r) => ({
      kind: 'correction',
      ...common(r),
      evaluationId: r.evaluation_id,
      reportId: r.report_id,
      correctionKind: r.kind,
      reasonCode: r.reason_code,
      previousCorrectionId: r.previous_correction_id,
      replacementEvaluationId: r.replacement_evaluation_id,
      note: note(r.note_id, r.note_digest),
    }),
  },
  cell_disputes: {
    sql: `SELECT d.id::text AS id, d.tenant_id, d.seq::text AS seq, d.created_by, ${UTC('d.created_at')} AS created_at, d.ledger_event_id::text AS ledger_event_id,
                 d.guideline_id, d.guideline_version, d.guideline_content_sha256, d.locator_table, d.locator_row, d.locator_column,
                 n.id::text AS note_id, n.body_sha256 AS note_digest
            FROM cell_disputes d LEFT JOIN event_notes n ON n.id = d.note_id AND n.tenant_id = d.tenant_id WHERE d.id = ANY($1::uuid[])`,
    project: (r) => ({
      kind: 'dispute',
      ...common(r),
      guidelineId: r.guideline_id,
      guidelineVersion: r.guideline_version,
      guidelineContentSha256: r.guideline_content_sha256,
      locatorTable: r.locator_table,
      locatorRow: r.locator_row,
      locatorColumn: r.locator_column,
      note: note(r.note_id, r.note_digest),
    }),
  },
  cell_dispute_decisions: {
    sql: `SELECT d.id::text AS id, d.tenant_id, d.seq::text AS seq, d.created_by, ${UTC('d.created_at')} AS created_at, d.ledger_event_id::text AS ledger_event_id,
                 d.dispute_id::text AS dispute_id, d.decision, n.id::text AS note_id, n.body_sha256 AS note_digest
            FROM cell_dispute_decisions d LEFT JOIN event_notes n ON n.id = d.evidence_note_id AND n.tenant_id = d.tenant_id WHERE d.id = ANY($1::uuid[])`,
    project: (r) => ({
      kind: 'dispute-decision',
      ...common(r),
      disputeId: r.dispute_id,
      decision: r.decision,
      evidence: note(r.note_id, r.note_digest),
    }),
  },
  report_patient_decisions: {
    sql: `SELECT id::text AS id, tenant_id, seq::text AS seq, created_by, ${UTC('created_at')} AS created_at, ledger_event_id::text AS ledger_event_id,
                 report_id::text AS report_id, patient_id::text AS patient_id, report_sha256, object_version, decision, method, basis_code,
                 identifier_id::text AS identifier_id
            FROM report_patient_decisions WHERE id = ANY($1::uuid[])`,
    project: (r) => ({
      kind: 'patient-link-decision',
      ...common(r),
      reportId: r.report_id,
      patientId: r.patient_id,
      reportSha256: r.report_sha256,
      objectVersion: r.object_version,
      decision: r.decision,
      method: r.method,
      basisCode: r.basis_code,
      identifierId: r.identifier_id,
    }),
  },
  patient_merge_proposals: {
    sql: `SELECT id::text AS id, tenant_id, seq::text AS seq, created_by, ${UTC('created_at')} AS created_at, ledger_event_id::text AS ledger_event_id,
                 kind, source_patient_id::text AS source_patient_id, target_patient_id::text AS target_patient_id, reason_code
            FROM patient_merge_proposals WHERE id = ANY($1::uuid[])`,
    project: (r) => ({
      kind: 'patient-merge-proposal',
      ...common(r),
      mergeKind: r.kind,
      sourcePatientId: r.source_patient_id,
      targetPatientId: r.target_patient_id,
      reasonCode: r.reason_code,
    }),
  },
  patient_merge_decisions: {
    sql: `SELECT id::text AS id, tenant_id, seq::text AS seq, created_by, ${UTC('created_at')} AS created_at, ledger_event_id::text AS ledger_event_id,
                 proposal_id::text AS proposal_id, decision
            FROM patient_merge_decisions WHERE id = ANY($1::uuid[])`,
    project: (r) => ({ kind: 'patient-merge-decision', ...common(r), proposalId: r.proposal_id, decision: r.decision }),
  },
  // Every column as stored except the retry identity (as capture decisions, 0044); the note is its {id, bodySha256}.
  clinician_result_decisions: {
    sql: `SELECT d.id::text AS id, d.tenant_id, d.seq::text AS seq, d.created_by, ${UTC('d.created_at')} AS created_at, d.ledger_event_id::text AS ledger_event_id,
                 d.result_id::text AS result_id, d.evaluation_id::text AS evaluation_id, d.patient_id::text AS patient_id, d.author_roles,
                 d.membership_version::text AS membership_version, d.entry_kind, d.previous_entry_id::text AS previous_entry_id, d.response, d.detail_codes,
                 to_char(d.review_by, 'YYYY-MM-DD') AS review_by, d.vocabulary_version, ${UTC('d.occurred_at')} AS occurred_at, d.occurred_at_source,
                 d.eligibility_policy, n.id::text AS note_id, n.body_sha256 AS note_digest
            FROM clinician_result_decisions d LEFT JOIN event_notes n ON n.id = d.note_id AND n.tenant_id = d.tenant_id WHERE d.id = ANY($1::uuid[])`,
    project: (r) => ({
      kind: 'clinician-result-decision',
      ...common(r),
      resultId: r.result_id,
      evaluationId: r.evaluation_id,
      patientId: r.patient_id,
      authorRoles: r.author_roles,
      membershipVersion: r.membership_version,
      entryKind: r.entry_kind,
      previousEntryId: r.previous_entry_id,
      response: r.response,
      detailCodes: r.detail_codes,
      reviewBy: r.review_by,
      vocabularyVersion: r.vocabulary_version,
      occurredAt: r.occurred_at,
      occurredAtSource: r.occurred_at_source,
      eligibilityPolicy: r.eligibility_policy,
      note: note(r.note_id, r.note_digest),
    }),
  },
};

const EVALUATION_SQL = `SELECT id::text AS id, tenant_id, seq::text AS seq, created_by, ${UTC('created_at')} AS created_at, ledger_event_id::text AS ledger_event_id,
       patient_id::text AS patient_id, report_id::text AS report_id, capture_id::text AS capture_id, capture_acceptance_id::text AS capture_acceptance_id,
       disposition, hold_code, binding, knowledge_set_id, engine_version, gene_inputs, occurrences, identity_key
  FROM evaluations WHERE id = ANY($1::uuid[])`;
const RESULTS_SQL = `SELECT id::text AS id, evaluation_id::text AS evaluation_id, ordinal, drug, genes, outcome, reason_code, strength, citation, guideline_id,
       guideline_version, recommendation_text, implication, gene_evidence FROM evaluation_results WHERE evaluation_id = ANY($1::uuid[])`;
const GENE_STATES_SQL = `SELECT id::text AS id, evaluation_id::text AS evaluation_id, gene, state, phenotype, diplotype, activity_score::text AS activity_score, reason_code
  FROM evaluation_gene_states WHERE evaluation_id = ANY($1::uuid[])`;

/** UTF-16 code unit order, independent of any database or locale setting. */
const byUnits = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

async function loadEvaluations(db: Queryable, ids: string[]): Promise<Map<string, Projection>> {
  // Sequential on purpose: one client runs one query at a time (concurrent calls are deprecated in node-postgres).
  const headers = await db.query<Row>(EVALUATION_SQL, [ids]);
  const results = await db.query<Row>(RESULTS_SQL, [ids]);
  const states = await db.query<Row>(GENE_STATES_SQL, [ids]);
  const out = new Map<string, Projection>();
  for (const h of headers.rows) {
    const id = h.id as string;
    const ownResults = results.rows.filter((r) => r.evaluation_id === id).sort((a, b) => (a.ordinal as number) - (b.ordinal as number));
    const ownStates = states.rows.filter((r) => r.evaluation_id === id).sort((a, b) => byUnits(a.gene as string, b.gene as string));
    out.set(id, {
      kind: 'evaluation',
      ...common(h),
      patientId: h.patient_id,
      reportId: h.report_id,
      captureId: h.capture_id,
      captureAcceptanceId: h.capture_acceptance_id,
      disposition: h.disposition,
      holdCode: h.hold_code,
      binding: h.binding,
      knowledgeSetId: h.knowledge_set_id,
      engineVersion: h.engine_version,
      geneInputs: h.gene_inputs,
      occurrences: h.occurrences,
      identityKey: h.identity_key,
      results: ownResults.map((r) => ({
        id: r.id,
        ordinal: r.ordinal,
        drug: r.drug,
        genes: r.genes,
        outcome: r.outcome,
        reasonCode: r.reason_code,
        strength: r.strength,
        citation: r.citation,
        guidelineId: r.guideline_id,
        guidelineVersion: r.guideline_version,
        recommendationText: r.recommendation_text,
        implication: r.implication,
        geneEvidence: r.gene_evidence,
      })),
      geneStates: ownStates.map((s) => ({
        id: s.id,
        gene: s.gene,
        state: s.state,
        phenotype: s.phenotype,
        diplotype: s.diplotype,
        activityScore: s.activity_score,
        reasonCode: s.reason_code,
      })),
    });
  }
  return out;
}

/** Loads the projection of each id (rows that do not exist are simply absent from the result). */
export async function loadProjections(db: Queryable, table: RecordTable, ids: string[]): Promise<Map<string, Projection>> {
  if (ids.length === 0) return new Map();
  if (table === 'evaluations') return loadEvaluations(db, ids);
  const loader = LOADERS[table];
  const { rows } = await db.query<Row>(loader.sql, [ids]);
  return new Map(rows.map((row) => [row.id as string, loader.project(row)]));
}

/** SHA-256 of the canonical JSON of a projection: the `payload_sha256` of its ledger event. */
export const projectionHash = (projection: Projection): string => canonicalHash(projection);
