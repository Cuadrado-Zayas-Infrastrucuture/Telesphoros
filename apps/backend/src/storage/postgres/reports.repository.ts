import { Injectable } from '@nestjs/common';
import type { ReportStatus, ReportType } from '@telesphoros/shared-types';
import { Database } from '../../db/database';
import { toStorageError } from '../errors';
import type { Page, PageRequest, ReportRecord } from '../records';
import { type ReportFilter, ReportsRepository } from '../reports.repository';

interface ReportRow {
  id: string;
  owner_id: string;
  patient_id: string;
  type: ReportType;
  original_filename: string;
  size_bytes: string; // bigint arrives as a string
  status: ReportStatus;
  content_type: string | null;
  sha256: string | null;
  storage_key: string | null;
  uploaded_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

const COLUMNS =
  'id, owner_id, patient_id, type, original_filename, size_bytes, status, content_type, sha256, storage_key, uploaded_at, created_at, updated_at';

const toRecord = (row: ReportRow): ReportRecord => ({
  id: row.id,
  ownerId: row.owner_id,
  patientId: row.patient_id,
  type: row.type,
  filename: row.original_filename,
  sizeBytes: Number(row.size_bytes),
  status: row.status,
  contentType: row.content_type,
  sha256: row.sha256,
  storageKey: row.storage_key,
  uploadedAt: row.uploaded_at ? row.uploaded_at.toISOString() : null,
  createdAt: row.created_at.toISOString(),
  updatedAt: row.updated_at.toISOString(),
});

@Injectable()
export class PostgresReportsRepository extends ReportsRepository {
  constructor(private readonly db: Database) {
    super();
  }

  list(ownerId: string, { offset, limit }: PageRequest, filter: ReportFilter): Promise<Page<ReportRecord>> {
    return this.db.withOwner(ownerId, async (client) => {
      // `$2::uuid IS NULL OR patient_id = $2` keeps ONE static query text for both filtered and unfiltered lists.
      const where = 'owner_id = $1 AND deleted_at IS NULL AND ($2::uuid IS NULL OR patient_id = $2::uuid)';
      const rows = await client.query<ReportRow>(
        `SELECT ${COLUMNS} FROM reports WHERE ${where} ORDER BY seq LIMIT $3 OFFSET $4`,
        [ownerId, filter.patientId ?? null, limit, offset],
      );
      const total = await client.query<{ n: number }>(`SELECT count(*)::int AS n FROM reports WHERE ${where}`, [
        ownerId,
        filter.patientId ?? null,
      ]);
      return { items: rows.rows.map(toRecord), total: total.rows[0]!.n };
    });
  }

  findById(ownerId: string, id: string): Promise<ReportRecord | undefined> {
    return this.db.withOwner(ownerId, async (client) => {
      const { rows } = await client.query<ReportRow>(
        `SELECT ${COLUMNS} FROM reports WHERE id = $1 AND owner_id = $2 AND deleted_at IS NULL`,
        [id, ownerId],
      );
      return rows[0] ? toRecord(rows[0]) : undefined;
    });
  }

  countByPatient(ownerId: string, patientId: string): Promise<number> {
    return this.db.withOwner(ownerId, async (client) => {
      const { rows } = await client.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM reports WHERE owner_id = $1 AND patient_id = $2 AND deleted_at IS NULL',
        [ownerId, patientId],
      );
      return rows[0]!.n;
    });
  }

  async insert(record: ReportRecord): Promise<void> {
    try {
      await this.db.withOwner(record.ownerId, (client) =>
        client.query(
          `INSERT INTO reports (id, owner_id, patient_id, type, original_filename, size_bytes, status,
                                content_type, sha256, storage_key, uploaded_at, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
          [
            record.id, record.ownerId, record.patientId, record.type, record.filename, record.sizeBytes,
            record.status, record.contentType ?? null, record.sha256 ?? null, record.storageKey ?? null,
            record.uploadedAt ?? null, record.createdAt, record.updatedAt,
          ],
        ),
      );
    } catch (error) {
      throw toStorageError(error);
    }
  }

  async update(record: ReportRecord): Promise<void> {
    try {
      await this.db.withOwner(record.ownerId, (client) =>
        client.query(
          `UPDATE reports
              SET type = $3, original_filename = $4, status = $5, content_type = $6, sha256 = $7,
                  storage_key = $8, uploaded_at = $9, updated_at = $10
            WHERE id = $1 AND owner_id = $2 AND deleted_at IS NULL`,
          [
            record.id, record.ownerId, record.type, record.filename, record.status,
            record.contentType ?? null, record.sha256 ?? null, record.storageKey ?? null,
            record.uploadedAt ?? null, record.updatedAt,
          ],
        ),
      );
    } catch (error) {
      throw toStorageError(error);
    }
  }

  async delete(ownerId: string, id: string): Promise<boolean> {
    try {
      return await this.db.withOwner(ownerId, async (client) => {
        const result = await client.query(
          'UPDATE reports SET deleted_at = now(), updated_at = now() WHERE id = $1 AND owner_id = $2 AND deleted_at IS NULL',
          [id, ownerId],
        );
        return (result.rowCount ?? 0) > 0;
      });
    } catch (error) {
      throw toStorageError(error);
    }
  }
}
