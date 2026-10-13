import { Injectable } from '@nestjs/common';
import { Database } from '../../db/database';
import { IdentifierInUseError, type IdentifierRecord, PatientIdentifiersRepository } from '../patient-identifiers.repository';

interface Row {
  id: string;
  tenant_id: string;
  patient_id: string;
  system: string;
  value_digest: Buffer;
  key_version: number;
  status: 'active' | 'withdrawn';
  created_by: string;
  created_at: Date;
  withdrawn_at: Date | null;
}

const COLUMNS = 'id, tenant_id, patient_id, system, value_digest, key_version, status, created_by, created_at, withdrawn_at';
const toRecord = (r: Row): IdentifierRecord => ({
  id: r.id, tenantId: r.tenant_id, patientId: r.patient_id, system: r.system, digest: r.value_digest, keyVersion: r.key_version, status: r.status,
  createdBy: r.created_by, createdAt: r.created_at, withdrawnAt: r.withdrawn_at,
});

/** Every query names `tenant_id` AND runs under row-level security. The digest is read only to compare; it is never logged. */
@Injectable()
export class PostgresPatientIdentifiersRepository extends PatientIdentifiersRepository {
  constructor(private readonly db: Database) {
    super();
  }

  add(tenantId: string, actor: string, input: { patientId: string; system: string; digest: Buffer; keyVersion: number }): Promise<IdentifierRecord> {
    return this.db.withTenant(
      tenantId,
      async (client) => {
        try {
          const { rows } = await client.query<Row>(
            `INSERT INTO patient_identifiers (tenant_id, patient_id, system, value_digest, key_version, created_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING ${COLUMNS}`,
            [tenantId, input.patientId, input.system, input.digest, input.keyVersion, actor],
          );
          return toRecord(rows[0]!);
        } catch (error) {
          if ((error as { code?: string; constraint?: string }).code === '23505' && (error as { constraint?: string }).constraint === 'patient_identifiers_active_uq') throw new IdentifierInUseError();
          throw error;
        }
      },
      { actor },
    );
  }

  list(tenantId: string, patientId: string): Promise<IdentifierRecord[]> {
    return this.db.withTenant(tenantId, async (client) => {
      const { rows } = await client.query<Row>(`SELECT ${COLUMNS} FROM patient_identifiers WHERE tenant_id = $1 AND patient_id = $2 ORDER BY seq`, [tenantId, patientId]);
      return rows.map(toRecord);
    });
  }

  withdraw(tenantId: string, actor: string, patientId: string, identifierId: string): Promise<boolean> {
    return this.db.withTenant(
      tenantId,
      async (client) => {
        const result = await client.query(
          `UPDATE patient_identifiers SET status = 'withdrawn', withdrawn_by = $4, withdrawn_at = now()
            WHERE tenant_id = $1 AND patient_id = $2 AND id = $3 AND status = 'active'`,
          [tenantId, patientId, identifierId, actor],
        );
        return result.rowCount === 1;
      },
      { actor },
    );
  }

  findActiveOfPatient(tenantId: string, patientId: string, system: string, digest: Buffer): Promise<IdentifierRecord | undefined> {
    return this.db.withTenant(tenantId, async (client) => {
      const { rows } = await client.query<Row>(
        `SELECT ${COLUMNS} FROM patient_identifiers WHERE tenant_id = $1 AND patient_id = $2 AND system = $3 AND value_digest = $4 AND status = 'active'`,
        [tenantId, patientId, system, digest],
      );
      return rows[0] ? toRecord(rows[0]) : undefined;
    });
  }
}
