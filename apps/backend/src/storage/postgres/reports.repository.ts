import { Injectable } from '@nestjs/common';
import type { ReportStatus, ReportType } from '@telesphoros/shared-types';
import { Database } from '../../db/database';
import { toStorageError } from '../errors';
import type { Page, PageRequest, ReportRecord } from '../records';
import { type ReportFilter, ReportsRepository } from '../reports.repository';

interface ReportRow {
  id: string;
  tenant_id: string;
  created_by: string;
  patient_id: string;
  type: ReportType;
  original_filename: string;
  size_bytes: string; // bigint arrives as a string
  status: ReportStatus;
  content_type: string | null;
  sha256: string | null;
  storage_key: string | null;
  uploaded_at: Date | null;
  object_version: string | null;
  upload_requested_by: string | null;
  uploaded_by: string | null;
  created_at: Date;
  updated_at: Date;
}

const COLUMNS =
  'id, tenant_id, created_by, patient_id, type, original_filename, size_bytes, status, content_type, sha256, storage_key, uploaded_at, object_version, upload_requested_by, uploaded_by, created_at, updated_at';

const toRecord = (row: ReportRow): ReportRecord => ({
  id: row.id,
  tenantId: row.tenant_id,
  createdBy: row.created_by,
  patientId: row.patient_id,
  type: row.type,
  filename: row.original_filename,
  sizeBytes: Number(row.size_bytes),
  status: row.status,
  contentType: row.content_type,
  sha256: row.sha256,
  storageKey: row.storage_key,
  uploadedAt: row.uploaded_at ? row.uploaded_at.toISOString() : null,
  objectVersion: row.object_version,
  uploadRequestedBy: row.upload_requested_by,
  uploadedBy: row.uploaded_by,
  createdAt: row.created_at.toISOString(),
  updatedAt: row.updated_at.toISOString(),
});

@Injectable()
export class PostgresReportsRepository extends ReportsRepository {
  constructor(private readonly db: Database) {
    super();
  }

  list(tenantId: string, { offset, limit }: PageRequest, filter: ReportFilter): Promise<Page<ReportRecord>> {
    return this.db.withTenant(tenantId, async (client) => {
      // `$2::uuid IS NULL OR patient_id = $2` keeps ONE static query text for both filtered and unfiltered lists.
      const where = 'tenant_id = $1 AND deleted_at IS NULL AND ($2::uuid IS NULL OR patient_id = $2::uuid)';
      const rows = await client.query<ReportRow>(
        `SELECT ${COLUMNS} FROM reports WHERE ${where} ORDER BY seq LIMIT $3 OFFSET $4`,
        [tenantId, filter.patientId ?? null, limit, offset],
      );
      const total = await client.query<{ n: number }>(`SELECT count(*)::int AS n FROM reports WHERE ${where}`, [
        tenantId,
        filter.patientId ?? null,
      ]);
      return { items: rows.rows.map(toRecord), total: total.rows[0]!.n };
    });
  }

  findById(tenantId: string, id: string): Promise<ReportRecord | undefined> {
    return this.db.withTenant(tenantId, async (client) => {
      const { rows } = await client.query<ReportRow>(
        `SELECT ${COLUMNS} FROM reports WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL`,
        [id, tenantId],
      );
      return rows[0] ? toRecord(rows[0]) : undefined;
    });
  }

  countByPatient(tenantId: string, patientId: string): Promise<number> {
    return this.db.withTenant(tenantId, async (client) => {
      const { rows } = await client.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM reports WHERE tenant_id = $1 AND patient_id = $2 AND deleted_at IS NULL',
        [tenantId, patientId],
      );
      return rows[0]!.n;
    });
  }

  async insert(record: ReportRecord): Promise<void> {
    try {
      await this.db.withTenant(record.tenantId, (client) =>
        client.query(
          `INSERT INTO reports (id, tenant_id, created_by, patient_id, type, original_filename, size_bytes, status,
                                content_type, sha256, storage_key, uploaded_at, object_version, upload_requested_by, uploaded_by, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)`,
          [
            record.id, record.tenantId, record.createdBy, record.patientId, record.type, record.filename, record.sizeBytes,
            record.status, record.contentType ?? null, record.sha256 ?? null, record.storageKey ?? null,
            record.uploadedAt ?? null, record.objectVersion ?? null, record.uploadRequestedBy ?? null, record.uploadedBy ?? null,
            record.createdAt, record.updatedAt,
          ],
        ),
      );
    } catch (error) {
      throw toStorageError(error);
    }
  }

  async update(record: ReportRecord): Promise<void> {
    try {
      await this.db.withTenant(record.tenantId, (client) =>
        client.query(
          `UPDATE reports SET type = $3, original_filename = $4, status = $5, updated_at = $6
            WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL`,
          [record.id, record.tenantId, record.type, record.filename, record.status, record.updatedAt],
        ),
      );
    } catch (error) {
      throw toStorageError(error);
    }
  }

  async recordUploadRequest(record: ReportRecord): Promise<boolean> {
    try {
      return await this.db.withTenant(record.tenantId, async (client) => {
        // COALESCE keeps the FIRST requester; `uploaded_at IS NULL` means a request that lost a race to completion changes nothing.
        const result = await client.query(
          `UPDATE reports
              SET storage_key = $3, content_type = $4, sha256 = $5, upload_requested_by = COALESCE(upload_requested_by, $6), updated_at = $7
            WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL AND uploaded_at IS NULL`,
          [record.id, record.tenantId, record.storageKey ?? null, record.contentType ?? null, record.sha256 ?? null, record.uploadRequestedBy ?? null, record.updatedAt],
        );
        return (result.rowCount ?? 0) > 0;
      });
    } catch (error) {
      throw toStorageError(error);
    }
  }

  async markUploaded(record: ReportRecord): Promise<boolean> {
    try {
      return await this.db.withTenant(record.tenantId, async (client) => {
        const result = await client.query(
          `UPDATE reports SET uploaded_at = $3, object_version = $4, uploaded_by = $5, updated_at = $6
            WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL AND uploaded_at IS NULL`,
          [record.id, record.tenantId, record.uploadedAt ?? null, record.objectVersion ?? null, record.uploadedBy ?? null, record.updatedAt],
        );
        return (result.rowCount ?? 0) > 0;
      });
    } catch (error) {
      throw toStorageError(error);
    }
  }

  async delete(tenantId: string, id: string): Promise<boolean> {
    try {
      return await this.db.withTenant(tenantId, async (client) => {
        const result = await client.query(
          'UPDATE reports SET deleted_at = now(), updated_at = now() WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL',
          [id, tenantId],
        );
        return (result.rowCount ?? 0) > 0;
      });
    } catch (error) {
      throw toStorageError(error);
    }
  }
}
