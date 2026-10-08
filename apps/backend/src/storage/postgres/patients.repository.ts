import { Injectable } from '@nestjs/common';
import { Database } from '../../db/database';
import { toStorageError } from '../errors';
import { PatientsRepository } from '../patients.repository';
import type { Page, PageRequest, PatientRecord } from '../records';

interface PatientRow {
  id: string;
  tenant_id: string;
  created_by: string;
  label: string;
  created_at: Date;
  updated_at: Date;
}

const COLUMNS = 'id, tenant_id, created_by, label, created_at, updated_at';

const toRecord = (row: PatientRow): PatientRecord => ({
  id: row.id,
  tenantId: row.tenant_id,
  createdBy: row.created_by,
  label: row.label,
  createdAt: row.created_at.toISOString(),
  updatedAt: row.updated_at.toISOString(),
});

/**
 * Every query names `tenant_id` explicitly AND runs under row-level security: two independent
 * layers, so a mistake in one still cannot expose another tenant's rows. "Delete" is a soft delete.
 */
@Injectable()
export class PostgresPatientsRepository extends PatientsRepository {
  constructor(private readonly db: Database) {
    super();
  }

  list(tenantId: string, { offset, limit }: PageRequest): Promise<Page<PatientRecord>> {
    return this.db.withTenant(tenantId, async (client) => {
      const rows = await client.query<PatientRow>(
        `SELECT ${COLUMNS} FROM patients WHERE tenant_id = $1 AND deleted_at IS NULL ORDER BY seq LIMIT $2 OFFSET $3`,
        [tenantId, limit, offset],
      );
      const total = await client.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM patients WHERE tenant_id = $1 AND deleted_at IS NULL',
        [tenantId],
      );
      return { items: rows.rows.map(toRecord), total: total.rows[0]!.n };
    });
  }

  findById(tenantId: string, id: string): Promise<PatientRecord | undefined> {
    return this.db.withTenant(tenantId, async (client) => {
      const { rows } = await client.query<PatientRow>(
        `SELECT ${COLUMNS} FROM patients WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL`,
        [id, tenantId],
      );
      return rows[0] ? toRecord(rows[0]) : undefined;
    });
  }

  findByLabel(tenantId: string, label: string): Promise<PatientRecord | undefined> {
    return this.db.withTenant(tenantId, async (client) => {
      const { rows } = await client.query<PatientRow>(
        `SELECT ${COLUMNS} FROM patients WHERE tenant_id = $1 AND lower(label) = lower($2) AND deleted_at IS NULL`,
        [tenantId, label],
      );
      return rows[0] ? toRecord(rows[0]) : undefined;
    });
  }

  async insert(record: PatientRecord): Promise<void> {
    try {
      await this.db.withTenant(record.tenantId, (client) =>
        client.query(
          'INSERT INTO patients (id, tenant_id, created_by, label, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6)',
          [record.id, record.tenantId, record.createdBy, record.label, record.createdAt, record.updatedAt],
        ),
      );
    } catch (error) {
      throw toStorageError(error);
    }
  }

  async update(record: PatientRecord): Promise<void> {
    try {
      await this.db.withTenant(record.tenantId, (client) =>
        client.query(
          'UPDATE patients SET label = $3, updated_at = $4 WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL',
          [record.id, record.tenantId, record.label, record.updatedAt],
        ),
      );
    } catch (error) {
      throw toStorageError(error);
    }
  }

  async delete(tenantId: string, id: string): Promise<boolean> {
    try {
      return await this.db.withTenant(tenantId, async (client) => {
        const result = await client.query(
          'UPDATE patients SET deleted_at = now(), updated_at = now() WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL',
          [id, tenantId],
        );
        return (result.rowCount ?? 0) > 0;
      });
    } catch (error) {
      throw toStorageError(error);
    }
  }
}
