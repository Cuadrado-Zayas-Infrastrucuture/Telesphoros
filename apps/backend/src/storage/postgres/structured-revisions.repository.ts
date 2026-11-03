import { Injectable } from '@nestjs/common';
import {
  SYNTHETIC_PGX_SCHEMA_VERSION,
  syntheticPgxLabReportSchema,
  type StructuredFindingReviewCreate,
  type StructuredPreview,
  type StructuredSourceResolutionCreate,
} from '@telesphoros/shared-types';
import { AppException } from '../../common/app-exception';
import { Database } from '../../db/database';
import { toLedgerError } from '../../ledger/ledger-types';
import { newId } from '../../ledger/ledger-writer';
import { LedgerRecordsRepository } from '../ledger-records.repository';
import { StructuredRevisionsRepository, type SnapshotCheck, type StructuredSnapshot } from '../structured-revisions.repository';
import type { PoolClient } from 'pg';

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
interface ReviewRow {
  id: string;
  revision_id: string;
  source_finding_id: string;
  decision: 'accepted-as-evidence' | 'rejected' | 'held';
  reason_code: string;
  created_at: string;
}
interface ResolutionRow {
  id: string;
  laboratory_id: string;
  series_id: string;
  revision: number;
  revision_ids: string[];
  outcome: 'use-revision' | 'none-usable' | 'keep-held';
  chosen_revision_id: string | null;
  reason_code: string;
  created_at: string;
}
const MAX_RESOLUTIONS = 1000;
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
  async read(tenant: string, preview: StructuredPreview): Promise<StructuredSnapshot> {
    return this.db.withTenant(tenant, (client) => this.snapshot(client, tenant, preview));
  }
  // Revisions, the newest decision per finding and every resolution come from ONE statement, so they describe the same instant.
  private async snapshot(client: PoolClient, tenant: string, preview: StructuredPreview): Promise<StructuredSnapshot> {
    const result = await client.query<{ available: boolean; records: Row[]; reviews: ReviewRow[]; resolutions: ResolutionRow[] }>(
      `SELECT EXISTS(
        SELECT 1 FROM reports r JOIN patients p ON p.id=r.patient_id AND p.tenant_id=r.tenant_id
        WHERE r.tenant_id=$1 AND r.patient_id=$2 AND r.id=$3 AND r.sha256=$4 AND r.object_version=$5 AND
        r.deleted_at IS NULL AND p.deleted_at IS NULL AND patient_merged_into($1,$2) IS NULL) AS available,
        COALESCE((SELECT json_agg(x) FROM (${recordsSql}) x),'[]'::json) AS records,
        COALESCE((SELECT json_agg(f) FROM (SELECT DISTINCT ON (revision_id,source_finding_id) id,revision_id,source_finding_id,decision,reason_code,created_at
          FROM structured_finding_reviews WHERE tenant_id=$1 AND patient_id=$2 ORDER BY revision_id,source_finding_id,seq DESC) f),'[]'::json) AS reviews,
        COALESCE((SELECT json_agg(q) FROM (SELECT id,laboratory_id,series_id,revision,revision_ids,outcome,chosen_revision_id,reason_code,created_at
          FROM structured_source_resolutions WHERE tenant_id=$1 AND patient_id=$2 ORDER BY seq LIMIT ${MAX_RESOLUTIONS + 1}) q),'[]'::json) AS resolutions`,
      [tenant, preview.patientId, preview.reportId, preview.source.sha256, preview.source.objectVersion],
    );
    const snapshot = result.rows[0];
    if (!snapshot.available) throw AppException.conflict('The source or patient changed. Reopen the report.');
    if (snapshot.records.length > 100) throw AppException.conflict('The complete source history exceeds this prototype limit.');
    if (snapshot.resolutions.length > MAX_RESOLUTIONS) throw AppException.conflict('The complete resolution history exceeds this prototype limit.');
    return {
      revisions: snapshot.records.map((r) => ({
        id: r.id,
        reportId: r.report_id,
        patientId: r.patient_id,
        sha256: r.report_sha256,
        objectVersion: r.object_version,
        patientLinkDecisionId: r.patient_link_decision_id,
        createdAt: new Date(r.created_at).toISOString(),
        laboratoryReport: syntheticPgxLabReportSchema.parse(r.laboratory_report),
        currentBinding: r.current_binding,
      })),
      reviews: snapshot.reviews.map((r) => ({
        id: r.id,
        revisionId: r.revision_id,
        findingId: r.source_finding_id,
        decision: r.decision,
        reasonCode: r.reason_code,
        createdAt: new Date(r.created_at).toISOString(),
      })),
      resolutions: snapshot.resolutions.map((r) => ({
        id: r.id,
        laboratoryId: r.laboratory_id,
        seriesId: r.series_id,
        revision: r.revision,
        revisionIds: r.revision_ids,
        outcome: r.outcome,
        chosenRevisionId: r.chosen_revision_id,
        reasonCode: r.reason_code,
        createdAt: new Date(r.created_at).toISOString(),
      })),
    };
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
      throw this.refusal(error);
    }
  }
  private refusal(error: unknown): unknown {
    const code = (error as { code?: string })?.code;
    if (code === 'SR001') return AppException.conflict('The source, patient or independent review changed. Reopen the report.');
    if (code === 'SR002') return AppException.conflict('The complete source history exceeds this prototype limit.');
    if (code === 'SR003') return AppException.conflict('This laboratory identity is already associated with another patient and requires reconciliation.');
    if (code === 'SR004') return AppException.conflict('A different reviewer is required: not the people who uploaded or saved this evidence.');
    if (code === 'SR005') return AppException.conflict('That finding is not part of the stored revision.');
    if (code === 'SR006') return AppException.conflict('This revision is not open for review: it is superseded or its source conflict is unresolved.');
    if (code === 'SR007') return AppException.conflict('The set of conflicting sources changed. Reopen the report.');
    if (code === 'SR008') return AppException.conflict('These stored sources do not conflict.');
    return toLedgerError(error);
  }
  // Both writers take the same two locks as save(), in the same order, so they serialize with new revisions and patient-link decisions.
  private async lock(client: PoolClient, tenant: string, reportId: string): Promise<void> {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`structured-pgx:${tenant}`]);
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`patient-link:${tenant}:${reportId}`]);
  }
  async recordReview(tenant: string, actor: string, preview: StructuredPreview, input: StructuredFindingReviewCreate, check: SnapshotCheck): Promise<boolean> {
    try {
      return await this.db.withTenant(
        tenant,
        async (client) => {
          await this.lock(client, tenant, preview.reportId);
          const existing = await client.query<{
            revision_id: string;
            source_finding_id: string;
            decision: string;
            reason_code: string;
            report_sha256: string;
            object_version: string;
            patient_link_decision_id: string;
          }>(
            `SELECT revision_id,source_finding_id,decision,reason_code,report_sha256,object_version,patient_link_decision_id
             FROM structured_finding_reviews WHERE tenant_id=$1 AND created_by=$2 AND request_id=$3`,
            [tenant, actor, input.requestId],
          );
          const prior = existing.rows[0];
          if (prior) {
            if (
              prior.revision_id !== input.revisionId ||
              prior.source_finding_id !== input.findingId ||
              prior.decision !== input.decision ||
              prior.reason_code !== input.reasonCode ||
              prior.report_sha256 !== input.sha256 ||
              prior.object_version !== input.objectVersion ||
              prior.patient_link_decision_id !== input.patientLinkDecisionId
            )
              throw AppException.conflict('That request id was already used for a different review.');
            return false;
          }
          check(await this.snapshot(client, tenant, preview));
          const id = newId(),
            eventId = newId();
          await client.query(
            `INSERT INTO structured_finding_reviews
            (id,tenant_id,created_by,ledger_event_id,request_id,revision_id,report_id,patient_id,report_sha256,object_version,patient_link_decision_id,source_finding_id,decision,reason_code)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
            [
              id,
              tenant,
              actor,
              eventId,
              input.requestId,
              input.revisionId,
              preview.reportId,
              preview.patientId,
              input.sha256,
              input.objectVersion,
              input.patientLinkDecisionId,
              input.findingId,
              input.decision,
              input.reasonCode,
            ],
          );
          await this.ledger.appendRecordEvent(client, tenant, 'structured_finding_reviews', id, eventId);
          // The shared ledger lock now orders this check after any earlier review, merge or revision change.
          check(await this.snapshot(client, tenant, preview));
          return true;
        },
        { actor },
      );
    } catch (error) {
      throw this.refusal(error);
    }
  }
  async recordResolution(tenant: string, actor: string, preview: StructuredPreview, input: StructuredSourceResolutionCreate, check: SnapshotCheck): Promise<boolean> {
    try {
      return await this.db.withTenant(
        tenant,
        async (client) => {
          await this.lock(client, tenant, preview.reportId);
          const existing = await client.query<{
            patient_id: string;
            laboratory_id: string;
            series_id: string;
            revision: number;
            revision_ids: string[];
            outcome: string;
            chosen_revision_id: string | null;
            reason_code: string;
          }>(
            `SELECT patient_id,laboratory_id,series_id,revision,revision_ids,outcome,chosen_revision_id,reason_code
             FROM structured_source_resolutions WHERE tenant_id=$1 AND created_by=$2 AND request_id=$3`,
            [tenant, actor, input.requestId],
          );
          const prior = existing.rows[0];
          if (prior) {
            if (
              prior.patient_id !== input.patientId ||
              prior.laboratory_id !== input.laboratoryId ||
              prior.series_id !== input.seriesId ||
              prior.revision !== input.revision ||
              [...prior.revision_ids].sort().join() !== [...input.revisionIds].sort().join() ||
              prior.outcome !== input.outcome ||
              prior.chosen_revision_id !== (input.chosenRevisionId ?? null) ||
              prior.reason_code !== input.reasonCode
            )
              throw AppException.conflict('That request id was already used for a different resolution.');
            return false;
          }
          check(await this.snapshot(client, tenant, preview));
          const id = newId(),
            eventId = newId();
          await client.query(
            `INSERT INTO structured_source_resolutions
            (id,tenant_id,created_by,ledger_event_id,request_id,patient_id,laboratory_id,series_id,revision,revision_ids,outcome,chosen_revision_id,reason_code)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::uuid[],$11,$12,$13)`,
            [
              id,
              tenant,
              actor,
              eventId,
              input.requestId,
              preview.patientId,
              input.laboratoryId,
              input.seriesId,
              input.revision,
              input.revisionIds,
              input.outcome,
              input.chosenRevisionId ?? null,
              input.reasonCode,
            ],
          );
          await this.ledger.appendRecordEvent(client, tenant, 'structured_source_resolutions', id, eventId);
          check(await this.snapshot(client, tenant, preview));
          return true;
        },
        { actor },
      );
    } catch (error) {
      throw this.refusal(error);
    }
  }
}
