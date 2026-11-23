import { createHash, randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type {
  FollowupClosureAck,
  FollowupClosureAckInput,
  FollowupClosureNotices,
  FollowupDto,
  FollowupInput,
  FollowupList,
  FollowupQuery,
  FollowupInboxFilters,
  FollowupResponseSummary,
} from '@telesphoros/shared-types';
import type { PoolClient } from 'pg';
import { Database } from '../../db/database';
import { AppException } from '../../common/app-exception';
import { toLedgerError } from '../../ledger/ledger-types';
import { LedgerRecordsRepository } from '../ledger-records.repository';
import { PatientFollowupsRepository } from '../patient-followups.repository';

interface Row {
  id: string;
  thread_id: string;
  patient_id: string;
  patient_label: string;
  medication_id: string;
  medication_name: string;
  decision_id: string | null;
  version: number;
  action: FollowupDto['action'];
  assessment: FollowupDto['assessment'];
  note: string;
  note_redacted: boolean;
  due_date: string | null;
  due_timezone: string | null;
  assignee: string | null;
  created_at: Date;
  created_by: string;
  current: boolean;
  due_state: FollowupDto['dueState'];
  needs_reassignment: boolean;
  creation_request_hash: string;
}
const latest = `WITH ranked AS (
  SELECT f.*, max(version) OVER (PARTITION BY thread_id) AS latest FROM patient_followups f WHERE tenant_id=$1
), visible AS (
  SELECT f.*, f.version=f.latest AS current, p.label AS patient_label, m.drug_name AS medication_name,
    n.body AS note, n.redacted_at IS NOT NULL AS note_redacted, f.due_date::text AS date_text,
    patient_followups_due_state(f.due_date,f.due_timezone,CURRENT_TIMESTAMP) AS due_state,
    f.assignee IS NOT NULL AND NOT EXISTS (SELECT 1 FROM tenant_memberships tm WHERE tm.tenant_id=$1 AND tm.sub=f.assignee AND tm.status='active' AND 'clinician'=ANY(tm.roles)) AS needs_reassignment
  FROM ranked f JOIN patients p ON p.id=f.patient_id AND p.tenant_id=f.tenant_id AND p.deleted_at IS NULL
  JOIN patient_medications m ON m.id=f.medication_id AND m.tenant_id=f.tenant_id
  JOIN event_notes n ON n.id=f.note_id AND n.tenant_id=f.tenant_id
)`;
function dto(row: Row & { date_text: string | null }): FollowupDto {
  return {
    id: row.id,
    threadId: row.thread_id,
    patientId: row.patient_id,
    patientLabel: row.patient_label,
    medicationId: row.medication_id,
    medicationName: row.medication_name,
    decisionId: row.decision_id,
    version: row.version,
    action: row.action,
    assessment: row.assessment,
    note: row.note,
    noteRedacted: row.note_redacted,
    next: row.date_text ? { date: row.date_text, timezone: row.due_timezone!, assignee: row.assignee! } : null,
    createdAt: row.created_at.toISOString(),
    createdBy: row.created_by,
    current: row.current,
    dueState: row.due_state,
    needsReassignment: row.needs_reassignment,
  };
}
@Injectable()
export class PostgresPatientFollowupsRepository extends PatientFollowupsRepository {
  constructor(
    private readonly db: Database,
    private readonly ledger: LedgerRecordsRepository,
  ) {
    super();
  }
  assignees(tenant: string): Promise<string[]> {
    return this.db.withTenant(tenant, async (client) => {
      const { rows } = await client.query<{ sub: string }>("SELECT sub FROM tenant_memberships WHERE tenant_id=$1 AND status='active' AND 'clinician'=ANY(roles) ORDER BY sub", [
        tenant,
      ]);
      return rows.map((row) => row.sub);
    });
  }
  summary(tenant: string): Promise<FollowupResponseSummary> {
    return this.db.withTenant(tenant, async (client) => {
      // One snapshot, independent of reminder pagination. Later scheduling actions cannot erase an assessment.
      const result = await client.query<{ as_of: Date; total: number } & FollowupResponseSummary['responses']>(
        `
        WITH subjects AS (
          SELECT DISTINCT f.thread_id FROM patient_followups f
          JOIN patients p ON p.id=f.patient_id AND p.tenant_id=f.tenant_id
          WHERE f.tenant_id=$1 AND p.deleted_at IS NULL
        ), assessments AS (
          SELECT DISTINCT ON (thread_id) thread_id, assessment FROM patient_followups
          WHERE tenant_id=$1 AND assessment IS NOT NULL ORDER BY thread_id, version DESC
        )
        SELECT CURRENT_TIMESTAMP AS as_of, count(*)::int AS total,
          count(*) FILTER (WHERE a.assessment->>'response'='improved')::int AS improved,
          count(*) FILTER (WHERE a.assessment->>'response'='unchanged')::int AS unchanged,
          count(*) FILTER (WHERE a.assessment->>'response'='worsened')::int AS worsened,
          count(*) FILTER (WHERE a.assessment->>'response'='not-assessed')::int AS "notAssessed",
          count(*) FILTER (WHERE a.assessment IS NULL)::int AS "noAssessment"
        FROM subjects s LEFT JOIN assessments a USING (thread_id)`,
        [tenant],
      );
      const { as_of, total, ...responses } = result.rows[0]!;
      return { definition: 'followup-response-v1', asOf: as_of.toISOString(), total, responses };
    });
  }
  read(tenant: string, patient: string | null, query: FollowupQuery & Partial<FollowupInboxFilters>, actor: string): Promise<FollowupList> {
    return this.db.withTenant(tenant, async (client) => {
      const { rows } = await client.query<Row & { date_text: string | null }>(
        `${latest}
        SELECT * FROM visible WHERE ($2::uuid IS NULL OR patient_id=$2) AND
        (CASE WHEN $3::uuid IS NULL THEN current ELSE thread_id=$3 END) AND ($2::uuid IS NOT NULL OR due_date IS NOT NULL)
        AND ($5::text='all' OR assignee=$6)
        AND ($7::text='all' OR ($7='reassignment' AND needs_reassignment) OR due_state=$7)
        ORDER BY CASE WHEN $3::uuid IS NOT NULL THEN version END DESC, needs_reassignment DESC, due_date ASC NULLS LAST, created_at DESC, id LIMIT 21 OFFSET $4`,
        [tenant, patient, query.threadId ?? null, (query.page - 1) * 20, query.assignment ?? 'all', actor, query.status ?? 'all'],
      );
      const counts = await client.query<FollowupList['counts']>(
        `${latest}
        SELECT count(*) FILTER (WHERE due_state='overdue')::int AS overdue,
          count(*) FILTER (WHERE due_state='today')::int AS today, count(*) FILTER (WHERE due_state='upcoming')::int AS upcoming,
          count(*) FILTER (WHERE needs_reassignment)::int AS unassigned
        FROM visible WHERE current AND ($2::uuid IS NULL OR patient_id=$2)`,
        [tenant, patient],
      );
      return { currentActor: actor, items: rows.slice(0, 20).map(dto), page: query.page, hasMore: rows.length > 20, counts: counts.rows[0]! };
    });
  }
  private async one(client: PoolClient, tenant: string, id: string): Promise<FollowupDto> {
    const { rows } = await client.query<Row & { date_text: string | null }>(`${latest} SELECT * FROM visible WHERE id=$2`, [tenant, id]);
    if (!rows[0]) throw AppException.notFound('Follow-up not found.');
    return dto(rows[0]);
  }
  async record(tenant: string, actor: string, patient: string, input: FollowupInput): Promise<FollowupDto> {
    const { requestId, ...data } = input;
    const hash = createHash('sha256')
      .update(JSON.stringify([patient, data]))
      .digest('hex');
    try {
      return await this.db.withTenant(
        tenant,
        async (client) => {
          await client.query("SELECT pg_advisory_xact_lock(hashtextextended('followup-request:' || $1 || ':' || $2 || ':' || $3,0))", [tenant, actor, requestId]);
          const replay = await client.query<{ id: string; creation_request_hash: string }>(
            'SELECT id,creation_request_hash FROM patient_followups WHERE tenant_id=$1 AND created_by=$2 AND creation_request_id=$3',
            [tenant, actor, requestId],
          );
          if (replay.rows[0]) {
            if (replay.rows[0].creation_request_hash !== hash) throw AppException.conflictBecause('request-id-reused', 'This save was already used for different follow-up data.');
            return this.one(client, tenant, replay.rows[0].id);
          }
          const id = randomUUID(),
            event = randomUUID(),
            note = randomUUID();
          await client.query("INSERT INTO event_notes (id,tenant_id,created_by,body,body_sha256) VALUES ($1,$2,$3,$4,encode(sha256(convert_to($4::text,'UTF8')),'hex'))", [
            note,
            tenant,
            actor,
            input.note,
          ]);
          await client.query(
            `INSERT INTO patient_followups
          (id,tenant_id,created_by,ledger_event_id,patient_id,thread_id,version,medication_id,decision_id,action,assessment,note_id,due_date,due_timezone,assignee,creation_request_id,creation_request_hash)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
            [
              id,
              tenant,
              actor,
              event,
              patient,
              input.threadId ?? randomUUID(),
              (input.expectedVersion ?? 0) + 1,
              input.medicationId,
              input.decisionId,
              input.action,
              input.assessment,
              note,
              input.next?.date ?? null,
              input.next?.timezone ?? null,
              input.next?.assignee ?? null,
              requestId,
              hash,
            ],
          );
          await this.ledger.appendRecordEvent(client, tenant, 'patient_followups', id, event);
          return this.one(client, tenant, id);
        },
        { actor },
      );
    } catch (error) {
      const code = (error as { code?: string })?.code;
      if (code === 'FU001') throw AppException.conflictBecause('followup-changed', 'This follow-up changed. Reload its current version before saving.');
      if (code === 'FU002' || code === '23503' || code === '23514' || code === '22007' || code === '22008')
        throw AppException.validation([{ field: 'followup', message: 'Check the patient, medication, assessment dates and responsible clinician.' }]);
      if (code === '42501') throw AppException.forbidden();
      throw toLedgerError(error);
    }
  }
  /**
   * Spec 047 FN-1, FN-2: dismiss versions written by someone else whose previous version was assigned to `actor`, not yet acknowledged.
   * One statement under the caller's tenant (row-level security, and the tenant named in the query as well).
   */
  closures(tenant: string, actor: string): Promise<FollowupClosureNotices> {
    return this.db.withTenant(tenant, async (client) => {
      const { rows } = await client.query<{
        followup_id: string;
        thread_id: string;
        patient_id: string;
        patient_label: string;
        medication_name: string;
        closed_by: string;
        closed_at: Date;
        note: string;
        note_redacted: boolean;
        total: number;
      }>(
        `SELECT d.id::text AS followup_id, d.thread_id::text AS thread_id, d.patient_id::text AS patient_id, p.label AS patient_label,
            m.drug_name AS medication_name, d.created_by AS closed_by, d.created_at AS closed_at, n.body AS note,
            n.redacted_at IS NOT NULL AS note_redacted, count(*) OVER ()::int AS total
          FROM patient_followups d
          JOIN patient_followups prior ON prior.tenant_id=d.tenant_id AND prior.thread_id=d.thread_id AND prior.version=d.version-1
          JOIN patients p ON p.id=d.patient_id AND p.tenant_id=d.tenant_id AND p.deleted_at IS NULL
          JOIN patient_medications m ON m.id=d.medication_id AND m.tenant_id=d.tenant_id
          JOIN event_notes n ON n.id=d.note_id AND n.tenant_id=d.tenant_id
          WHERE d.tenant_id=$1 AND d.action='dismiss' AND prior.assignee=$2 AND d.created_by<>$2
            AND NOT EXISTS (SELECT 1 FROM patient_followup_closure_acks a WHERE a.tenant_id=$1 AND a.followup_id=d.id)
          ORDER BY d.created_at DESC, d.id LIMIT 50`,
        [tenant, actor],
      );
      return {
        items: rows.map((r) => ({
          followupId: r.followup_id,
          threadId: r.thread_id,
          patientId: r.patient_id,
          patientLabel: r.patient_label,
          medicationName: r.medication_name,
          closedBy: r.closed_by,
          closedAt: r.closed_at.toISOString(),
          note: r.note,
          noteRedacted: r.note_redacted,
        })),
        total: rows[0]?.total ?? 0,
      };
    });
  }

  /** Spec 047 FN-3, FN-4: one acknowledgement and its ledger event, in one transaction. The trigger of migration 0076 is the guarantee. */
  async acknowledge(tenant: string, actor: string, thread: string, input: FollowupClosureAckInput): Promise<FollowupClosureAck> {
    const hash = createHash('sha256')
      .update(JSON.stringify([thread, input.followupId]))
      .digest('hex');
    const ack = (row: { id: string; followup_id: string; thread_id: string; created_at: Date }): FollowupClosureAck => ({
      id: row.id,
      followupId: row.followup_id,
      threadId: row.thread_id,
      acknowledgedAt: row.created_at.toISOString(),
    });
    const select = 'SELECT id::text AS id, followup_id::text AS followup_id, thread_id::text AS thread_id, created_at FROM patient_followup_closure_acks';
    try {
      return await this.db.withTenant(
        tenant,
        async (client) => {
          await client.query("SELECT pg_advisory_xact_lock(hashtextextended('followup-ack-request:' || $1 || ':' || $2 || ':' || $3,0))", [tenant, actor, input.requestId]);
          const replay = await client.query<{ id: string; followup_id: string; thread_id: string; created_at: Date; creation_request_hash: string }>(
            `${select.replace(' FROM', ', creation_request_hash FROM')} WHERE tenant_id=$1 AND created_by=$2 AND creation_request_id=$3`,
            [tenant, actor, input.requestId],
          );
          if (replay.rows[0]) {
            if (replay.rows[0].creation_request_hash !== hash)
              throw AppException.conflictBecause('request-id-reused', 'This save was already used for a different acknowledgement.');
            return ack(replay.rows[0]);
          }
          const closing = await client.query<{ thread_id: string }>('SELECT thread_id::text AS thread_id FROM patient_followups WHERE tenant_id=$1 AND id=$2', [
            tenant,
            input.followupId,
          ]);
          if (!closing.rows[0]) throw AppException.notFound('Follow-up not found.');
          if (closing.rows[0].thread_id !== thread) throw AppException.validation([{ field: 'followupId', message: 'This version is not of this follow-up.' }]);
          const id = randomUUID(),
            event = randomUUID();
          await client.query(
            `INSERT INTO patient_followup_closure_acks (id,tenant_id,created_by,ledger_event_id,followup_id,thread_id,patient_id,creation_request_id,creation_request_hash)
             SELECT $1,$2,$3,$4,f.id,f.thread_id,f.patient_id,$6,$7 FROM patient_followups f WHERE f.tenant_id=$2 AND f.id=$5`,
            [id, tenant, actor, event, input.followupId, input.requestId, hash],
          );
          await this.ledger.appendRecordEvent(client, tenant, 'patient_followup_closure_acks', id, event);
          return ack(
            (await client.query<{ id: string; followup_id: string; thread_id: string; created_at: Date }>(`${select} WHERE tenant_id=$1 AND id=$2`, [tenant, id])).rows[0]!,
          );
        },
        { actor },
      );
    } catch (error) {
      const code = (error as { code?: string })?.code;
      if (code === '23505') throw AppException.conflictBecause('already-acknowledged', 'This closure was already acknowledged.');
      if (code === 'FU002' || code === '23503' || code === '23514')
        throw AppException.validation([{ field: 'followupId', message: 'Only a reminder someone else closed can be acknowledged.' }]);
      if (code === '42501') throw AppException.forbidden();
      throw toLedgerError(error);
    }
  }
}
