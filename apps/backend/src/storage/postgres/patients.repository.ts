import { Injectable } from '@nestjs/common';
import { Database } from '../../db/database';
import { IntegrityError, toStorageError } from '../errors';
import { PatientsRepository } from '../patients.repository';
import type { Page, PageRequest, PatientRecord } from '../records';

interface PatientRow {
  id: string;
  tenant_id: string;
  created_by: string;
  label: string;
  created_at: Date;
  updated_at: Date;
  creation_request_id?: string | null;
  creation_request_hash?: string | null;
  deleted_at?: Date | null;
}

const COLUMNS = 'id, tenant_id, created_by, label, created_at, updated_at';
// The retry identity is read only where it is needed (a replay); the ordinary reads and the list do not carry it.
const REQUEST_COLUMNS = `${COLUMNS}, creation_request_id, creation_request_hash, deleted_at`;

const toRecord = (row: PatientRow): PatientRecord => ({
  id: row.id,
  tenantId: row.tenant_id,
  createdBy: row.created_by,
  label: row.label,
  createdAt: row.created_at.toISOString(),
  updatedAt: row.updated_at.toISOString(),
  ...(row.creation_request_id ? { creationRequestId: row.creation_request_id, creationRequestHash: row.creation_request_hash ?? undefined } : {}),
});

const INSERT = 'INSERT INTO patients (id, tenant_id, created_by, label, created_at, updated_at, creation_request_id, creation_request_hash) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)';
const insertValues = (r: PatientRecord) => [r.id, r.tenantId, r.createdBy, r.label, r.createdAt, r.updatedAt, r.creationRequestId ?? null, r.creationRequestHash ?? null];

/** A patient that was merged into another says so; one that was not carries no `mergedInto` at all (so it equals what any other store returns). */
const withMergedInto = (row: PatientRow & { merged_into: string | null }): PatientRecord => ({ ...toRecord(row), ...(row.merged_into ? { mergedInto: row.merged_into } : {}) });

/**
 * Every query names `tenant_id` explicitly AND runs under row-level security: two independent
 * layers, so a mistake in one still cannot expose another tenant's rows. "Delete" is a soft delete.
 */
@Injectable()
export class PostgresPatientsRepository extends PatientsRepository {
  constructor(private readonly db: Database) {
    super();
  }

  list(tenantId: string, { offset, limit }: PageRequest, options: { includeMerged?: boolean } = {}): Promise<Page<PatientRecord>> {
    return this.db.withTenant(tenantId, async (client) => {
      // The alias edges in force (a merge makes the source an alias of the target; nothing on the patient row changes).
      const rows = await client.query<PatientRow & { merged_into: string | null }>(
        `WITH edges AS MATERIALIZED (SELECT * FROM patient_alias_edges($1))
         SELECT ${COLUMNS.split(', ').map((c) => `p.${c}`).join(', ')}, e.target_patient_id::text AS merged_into
           FROM patients p LEFT JOIN edges e ON e.source_patient_id = p.id
          WHERE p.tenant_id = $1 AND p.deleted_at IS NULL AND ($4::boolean OR e.source_patient_id IS NULL) ORDER BY p.seq LIMIT $2 OFFSET $3`,
        [tenantId, limit, offset, options.includeMerged === true],
      );
      const total = await client.query<{ n: number }>(
        `WITH edges AS MATERIALIZED (SELECT * FROM patient_alias_edges($1))
         SELECT count(*)::int AS n FROM patients p LEFT JOIN edges e ON e.source_patient_id = p.id
          WHERE p.tenant_id = $1 AND p.deleted_at IS NULL AND ($2::boolean OR e.source_patient_id IS NULL)`,
        [tenantId, options.includeMerged === true],
      );
      return { items: rows.rows.map(withMergedInto), total: total.rows[0]!.n };
    });
  }

  findById(tenantId: string, id: string): Promise<PatientRecord | undefined> {
    return this.db.withTenant(tenantId, async (client) => {
      const { rows } = await client.query<PatientRow & { merged_into: string | null }>(
        `SELECT ${COLUMNS}, patient_merged_into($2, id)::text AS merged_into FROM patients WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL`,
        [id, tenantId],
      );
      return rows[0] ? withMergedInto(rows[0]) : undefined;
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
      await this.db.withTenant(record.tenantId, (client) => client.query(INSERT, insertValues(record)));
    } catch (error) {
      throw toStorageError(error);
    }
  }

  async insertOrReplay(record: PatientRecord): Promise<PatientRecord> {
    if (!record.creationRequestId || !record.creationRequestHash) throw new Error('Missing patient creation identity');
    try {
      return await this.db.withTenant(record.tenantId, async (client) => {
        const inserted = await client.query<PatientRow>(`${INSERT} ON CONFLICT DO NOTHING RETURNING ${REQUEST_COLUMNS}`, insertValues(record));
        if (inserted.rows[0]) return toRecord(inserted.rows[0]);
        // No conflict target on purpose: a concurrent repeat of the same request can meet the label's unique index before the request id's, and either way the
        // question is the same. A separate READ COMMITTED statement sees the winner once its insert has finished; a conflict with no row under this request id
        // was the label of another patient. No no-op UPDATE: it would touch the stored row on a replay.
        const existing = await client.query<PatientRow>(
          `SELECT ${REQUEST_COLUMNS} FROM patients WHERE tenant_id = $1 AND created_by = $2 AND creation_request_id = $3`,
          [record.tenantId, record.createdBy, record.creationRequestId],
        );
        const prior = existing.rows[0];
        if (!prior || prior.deleted_at || prior.creation_request_hash !== record.creationRequestHash) throw new IntegrityError('patients_creation_request_uq');
        return toRecord(prior);
      });
    } catch (error) {
      throw toStorageError(error);
    }
  }

  findByRequest(tenantId: string, createdBy: string, requestId: string): Promise<PatientRecord | undefined> {
    return this.db.withTenant(tenantId, async (client) => {
      const { rows } = await client.query<PatientRow>(
        `SELECT ${REQUEST_COLUMNS} FROM patients WHERE tenant_id = $1 AND created_by = $2 AND creation_request_id = $3`,
        [tenantId, createdBy, requestId],
      );
      return rows[0] ? toRecord(rows[0]) : undefined;
    });
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

  async hasMergedRecords(tenantId: string, id: string): Promise<boolean> {
    try {
      return await this.db.withTenant(tenantId, async (client) => {
        const { rows } = await client.query<{ merged: boolean }>(
          'SELECT EXISTS (SELECT 1 FROM patient_alias_edges($1) WHERE target_patient_id = $2) AS merged',
          [tenantId, id],
        );
        return rows[0]!.merged === true;
      });
    } catch (error) {
      throw toStorageError(error);
    }
  }

  async delete(tenantId: string, id: string, actor: string): Promise<boolean> {
    try {
      return await this.db.withTenant(tenantId, async (client) => {
        const result = await client.query(
          'UPDATE patients SET deleted_at = now(), updated_at = now() WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL',
          [id, tenantId],
        );
        if ((result.rowCount ?? 0) === 0) return false;
        // Same transaction: a deleted patient must not keep an active identifier (the unique index would go on holding the value for a record nobody can see).
        // Running after the patient update, the soft-delete trigger's refusals come first and nothing is withdrawn for a delete that did not happen.
        await client.query(
          `UPDATE patient_identifiers SET status = 'withdrawn', withdrawn_by = $3, withdrawn_at = now() WHERE tenant_id = $1 AND patient_id = $2 AND status = 'active'`,
          [tenantId, id, actor],
        );
        return true;
      }, { actor });
    } catch (error) {
      throw toStorageError(error);
    }
  }
}
