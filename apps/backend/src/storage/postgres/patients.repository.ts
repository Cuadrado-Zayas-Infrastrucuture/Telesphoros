import { Injectable } from '@nestjs/common';
import { Database } from '../../db/database';
import { toStorageError } from '../errors';
import { PatientsRepository } from '../patients.repository';
import type { Page, PageRequest, PatientRecord } from '../records';

interface PatientRow {
  id: string;
  owner_id: string;
  label: string;
  created_at: Date;
  updated_at: Date;
}

const COLUMNS = 'id, owner_id, label, created_at, updated_at';

const toRecord = (row: PatientRow): PatientRecord => ({
  id: row.id,
  ownerId: row.owner_id,
  label: row.label,
  createdAt: row.created_at.toISOString(),
  updatedAt: row.updated_at.toISOString(),
});

/**
 * Every query names `owner_id` explicitly AND runs under row-level security: two independent
 * layers, so a mistake in one still cannot expose another owner's rows. "Delete" is a soft delete.
 */
@Injectable()
export class PostgresPatientsRepository extends PatientsRepository {
  constructor(private readonly db: Database) {
    super();
  }

  list(ownerId: string, { offset, limit }: PageRequest): Promise<Page<PatientRecord>> {
    return this.db.withOwner(ownerId, async (client) => {
      const rows = await client.query<PatientRow>(
        `SELECT ${COLUMNS} FROM patients WHERE owner_id = $1 AND deleted_at IS NULL ORDER BY seq LIMIT $2 OFFSET $3`,
        [ownerId, limit, offset],
      );
      const total = await client.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM patients WHERE owner_id = $1 AND deleted_at IS NULL',
        [ownerId],
      );
      return { items: rows.rows.map(toRecord), total: total.rows[0]!.n };
    });
  }

  findById(ownerId: string, id: string): Promise<PatientRecord | undefined> {
    return this.db.withOwner(ownerId, async (client) => {
      const { rows } = await client.query<PatientRow>(
        `SELECT ${COLUMNS} FROM patients WHERE id = $1 AND owner_id = $2 AND deleted_at IS NULL`,
        [id, ownerId],
      );
      return rows[0] ? toRecord(rows[0]) : undefined;
    });
  }

  findByLabel(ownerId: string, label: string): Promise<PatientRecord | undefined> {
    return this.db.withOwner(ownerId, async (client) => {
      const { rows } = await client.query<PatientRow>(
        `SELECT ${COLUMNS} FROM patients WHERE owner_id = $1 AND lower(label) = lower($2) AND deleted_at IS NULL`,
        [ownerId, label],
      );
      return rows[0] ? toRecord(rows[0]) : undefined;
    });
  }

  async insert(record: PatientRecord): Promise<void> {
    try {
      await this.db.withOwner(record.ownerId, (client) =>
        client.query(
          'INSERT INTO patients (id, owner_id, label, created_at, updated_at) VALUES ($1, $2, $3, $4, $5)',
          [record.id, record.ownerId, record.label, record.createdAt, record.updatedAt],
        ),
      );
    } catch (error) {
      throw toStorageError(error);
    }
  }

  async update(record: PatientRecord): Promise<void> {
    try {
      await this.db.withOwner(record.ownerId, (client) =>
        client.query(
          'UPDATE patients SET label = $3, updated_at = $4 WHERE id = $1 AND owner_id = $2 AND deleted_at IS NULL',
          [record.id, record.ownerId, record.label, record.updatedAt],
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
          'UPDATE patients SET deleted_at = now(), updated_at = now() WHERE id = $1 AND owner_id = $2 AND deleted_at IS NULL',
          [id, ownerId],
        );
        return (result.rowCount ?? 0) > 0;
      });
    } catch (error) {
      throw toStorageError(error);
    }
  }
}
