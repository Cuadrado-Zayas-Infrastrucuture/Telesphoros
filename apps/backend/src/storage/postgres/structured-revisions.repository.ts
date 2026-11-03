import { Injectable } from '@nestjs/common';
import { SYNTHETIC_PGX_SCHEMA_VERSION, syntheticPgxLabReportSchema, type StructuredPreview } from '@telesphoros/shared-types';
import { AppException } from '../../common/app-exception';
import { Database } from '../../db/database';
import { toLedgerError } from '../../ledger/ledger-types';
import { newId } from '../../ledger/ledger-writer';
import { LedgerRecordsRepository } from '../ledger-records.repository';
import { StructuredRevisionsRepository, type StoredStructuredRevision } from '../structured-revisions.repository';

interface Row {
  id: string;
  report_id: string;
  patient_id: string;
  report_sha256: string;
  object_version: string;
  patient_link_decision_id: string;
  created_at: string;
  laboratory_report: unknown;
  current_binding: boolean;
}
// One SQL snapshot includes every stored source and its newest review. Never filter away an invalidated source.
const recordsSql = `SELECT s.*, COALESCE(r.deleted_at IS NULL AND r.uploaded_at IS NOT NULL AND r.patient_id=s.patient_id AND
  r.sha256=s.report_sha256 AND r.object_version=s.object_version AND d.id=s.patient_link_decision_id AND d.decision='verified' AND
  d.patient_id=s.patient_id AND d.report_sha256=s.report_sha256 AND d.object_version=s.object_version,false) AS current_binding
 FROM structured_report_revisions s LEFT JOIN reports r ON r.id=s.report_id AND r.tenant_id=s.tenant_id
 LEFT JOIN LATERAL (SELECT * FROM report_patient_decisions WHERE tenant_id=s.tenant_id AND report_id=s.report_id ORDER BY seq DESC LIMIT 1) d ON true
 WHERE s.tenant_id=$1 AND s.patient_id=$2 ORDER BY s.seq LIMIT 101`;

@Injectable()
export class PostgresStructuredRevisionsRepository extends StructuredRevisionsRepository {
  constructor(
    private readonly db: Database,
    private readonly ledger: LedgerRecordsRepository,
  ) {
    super();
  }
  async read(tenant: string, preview: StructuredPreview): Promise<StoredStructuredRevision[]> {
    return this.db.withTenant(tenant, async (client) => {
      const result = await client.query<{ available: boolean; records: Row[] }>(
        `SELECT EXISTS(
        SELECT 1 FROM reports r JOIN patients p ON p.id=r.patient_id AND p.tenant_id=r.tenant_id
        WHERE r.tenant_id=$1 AND r.patient_id=$2 AND r.id=$3 AND r.sha256=$4 AND r.object_version=$5 AND
        r.deleted_at IS NULL AND p.deleted_at IS NULL AND patient_merged_into($1,$2) IS NULL) AS available,
        COALESCE((SELECT json_agg(x) FROM (${recordsSql}) x),'[]'::json) AS records`,
        [tenant, preview.patientId, preview.reportId, preview.source.sha256, preview.source.objectVersion],
      );
      const snapshot = result.rows[0];
      if (!snapshot.available) throw AppException.conflict('The source or patient changed. Reopen the report.');
      if (snapshot.records.length > 100) throw AppException.conflict('The complete source history exceeds this prototype limit.');
      return snapshot.records.map((r) => ({
        id: r.id,
        reportId: r.report_id,
        patientId: r.patient_id,
        sha256: r.report_sha256,
        objectVersion: r.object_version,
        patientLinkDecisionId: r.patient_link_decision_id,
        createdAt: new Date(r.created_at).toISOString(),
        laboratoryReport: syntheticPgxLabReportSchema.parse(r.laboratory_report),
        currentBinding: r.current_binding,
      }));
    });
  }
  async save(tenant: string, actor: string, preview: StructuredPreview): Promise<boolean> {
    try {
      return await this.db.withTenant(
        tenant,
        async (client) => {
          await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`structured-pgx:${tenant}`]);
          await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`patient-link:${tenant}:${preview.reportId}`]);
          const current = async () => {
            const { rows } = await client.query<{ ok: boolean }>(
              `SELECT r.patient_id=$3 AND r.sha256=$4 AND r.object_version=$5 AND r.deleted_at IS NULL AND
            r.uploaded_at IS NOT NULL AND p.deleted_at IS NULL AND patient_merged_into($1,$3) IS NULL AND
            d.id=$6 AND d.decision='verified' AND d.patient_id=$3 AND d.report_sha256=$4 AND d.object_version=$5 AS ok
            FROM reports r JOIN patients p ON p.id=r.patient_id AND p.tenant_id=r.tenant_id
            LEFT JOIN LATERAL (SELECT * FROM report_patient_decisions WHERE tenant_id=$1 AND report_id=$2 ORDER BY seq DESC LIMIT 1) d ON true
            WHERE r.tenant_id=$1 AND r.id=$2 FOR SHARE OF r,p`,
              [tenant, preview.reportId, preview.patientId, preview.source.sha256, preview.source.objectVersion, preview.patientLink.decision?.id],
            );
            if (rows[0]?.ok !== true) throw AppException.conflict('The source, patient or independent review changed. Reopen the report.');
          };
          await current();
          const existing = await client.query<{ report_sha256: string; object_version: string; patient_id: string; patient_link_decision_id: string }>(
            'SELECT report_sha256,object_version,patient_id,patient_link_decision_id FROM structured_report_revisions WHERE tenant_id=$1 AND report_id=$2',
            [tenant, preview.reportId],
          );
          if (existing.rows[0]) {
            const r = existing.rows[0];
            if (
              r.report_sha256 !== preview.source.sha256 ||
              r.object_version !== preview.source.objectVersion ||
              r.patient_id !== preview.patientId ||
              r.patient_link_decision_id !== preview.patientLink.decision?.id
            )
              throw AppException.conflict('The stored evidence requires a new reconciliation review.');
            return false;
          }
          const id = newId(),
            eventId = newId();
          await client.query(
            `INSERT INTO structured_report_revisions
          (id,tenant_id,created_by,ledger_event_id,report_id,patient_id,report_sha256,object_version,patient_link_decision_id,parser_version,laboratory_report)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)`,
            [
              id,
              tenant,
              actor,
              eventId,
              preview.reportId,
              preview.patientId,
              preview.source.sha256,
              preview.source.objectVersion,
              preview.patientLink.decision?.id,
              SYNTHETIC_PGX_SCHEMA_VERSION,
              JSON.stringify(preview.laboratoryReport),
            ],
          );
          await this.ledger.appendRecordEvent(client, tenant, 'structured_report_revisions', id, eventId);
          // The shared ledger lock now orders this snapshot after any earlier review/merge changes.
          await current();
          return true;
        },
        { actor },
      );
    } catch (error) {
      const code = (error as { code?: string })?.code;
      if (code === 'SR001') throw AppException.conflict('The source, patient or independent review changed. Reopen the report.');
      if (code === 'SR002') throw AppException.conflict('The complete source history exceeds this prototype limit.');
      if (code === 'SR003') throw AppException.conflict('This laboratory identity is already associated with another patient and requires reconciliation.');
      throw toLedgerError(error);
    }
  }
}
