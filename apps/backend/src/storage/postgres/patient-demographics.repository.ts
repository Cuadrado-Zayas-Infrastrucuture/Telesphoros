import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { Database } from '../../db/database';
import { toLedgerError } from '../../ledger/ledger-types';
import { newId } from '../../ledger/ledger-writer';
import { LedgerRecordsRepository } from '../ledger-records.repository';
import {
  type CodedDemographics,
  DemographicsRequestRaceError,
  FieldKeyRaceError,
  IdentityErasedError,
  type KeyState,
  type NewDemographics,
  PatientDemographicsRepository,
  type StoredDemographics,
} from '../patient-demographics.repository';

interface Row {
  id: string;
  patient_id: string;
  version: number;
  key_version: number;
  given_name_ct: Buffer;
  given_name_nonce: Buffer;
  family_name_ct: Buffer;
  family_name_nonce: Buffer;
  date_of_birth_ct: Buffer;
  date_of_birth_nonce: Buffer;
  sex: StoredDemographics['sex'];
  birth_year: number;
  ethnicity: StoredDemographics['ethnicity'];
  created_at: Date;
  created_by: string;
  creation_request_hash: string | null;
}

const COLUMNS = `id::text AS id, patient_id::text AS patient_id, version, key_version, given_name_ct, given_name_nonce, family_name_ct, family_name_nonce,
                 date_of_birth_ct, date_of_birth_nonce, sex, birth_year, ethnicity, created_at, created_by, creation_request_hash`;

const toStored = (r: Row): StoredDemographics => ({
  id: r.id,
  patientId: r.patient_id,
  version: r.version,
  keyVersion: r.key_version,
  givenName: { nonce: r.given_name_nonce, ciphertext: r.given_name_ct },
  familyName: { nonce: r.family_name_nonce, ciphertext: r.family_name_ct },
  dateOfBirth: { nonce: r.date_of_birth_nonce, ciphertext: r.date_of_birth_ct },
  sex: r.sex,
  birthYear: r.birth_year,
  ethnicity: r.ethnicity,
  createdAt: r.created_at.toISOString(),
  createdBy: r.created_by,
  creationRequestHash: r.creation_request_hash,
});

/** SQLSTATE raised by the demographics and key triggers (migration 0064) when the patient's key is not available. */
const KEY_UNAVAILABLE = 'PD001';
const REQUEST_UNIQUE = 'patient_demographics_request_uq';

/**
 * The SQL of patient demographics. A write is one transaction: the key (for the first version), the version, and, as the LAST statement, the ledger event
 * (the append itself is the ledger repository's). At COMMIT the database refuses the transaction if the version and its event disagree.
 * Every query names `tenant_id` AND runs under forced row-level security. Nothing here decrypts, and nothing logs a value.
 */
@Injectable()
export class PostgresPatientDemographicsRepository extends PatientDemographicsRepository {
  constructor(
    private readonly db: Database,
    // The one holder of the ledger's append: it asks the watch's gate first, then appends.
    private readonly ledger: LedgerRecordsRepository,
  ) {
    super();
  }

  codedFor(tenantId: string, patientIds: readonly string[]): Promise<Map<string, CodedDemographics>> {
    if (patientIds.length === 0) return Promise.resolve(new Map());
    return this.db.withTenant(tenantId, async (client) => {
      const { rows } = await client.query<{ patient_id: string; version: number; sex: CodedDemographics['sex']; birth_year: number; ethnicity: CodedDemographics['ethnicity'] }>(
        `SELECT DISTINCT ON (patient_id) patient_id::text AS patient_id, version, sex, birth_year, ethnicity
           FROM patient_demographics WHERE tenant_id = $1 AND patient_id = ANY($2::uuid[]) ORDER BY patient_id, version DESC`,
        [tenantId, patientIds],
      );
      return new Map(rows.map((r) => [r.patient_id, { version: r.version, sex: r.sex, birthYear: r.birth_year, ethnicity: r.ethnicity }]));
    });
  }

  keyState(tenantId: string, patientId: string): Promise<KeyState> {
    return this.db.withTenant(tenantId, async (client) => {
      const { rows } = await client.query<{ key_version: number | null; wrapped_key: Buffer | null; provider: string | null; has_versions: boolean }>(
        `SELECT k.key_version, k.wrapped_key, k.provider,
                EXISTS (SELECT 1 FROM patient_demographics d WHERE d.tenant_id = $1 AND d.patient_id = $2) AS has_versions
           FROM (SELECT 1) AS one LEFT JOIN patient_field_keys k ON k.tenant_id = $1 AND k.patient_id = $2`,
        [tenantId, patientId],
      );
      const row = rows[0]!;
      return {
        hasVersions: row.has_versions,
        ...(row.wrapped_key ? { key: { keyVersion: row.key_version!, wrapped: row.wrapped_key, provider: row.provider! } } : {}),
      };
    });
  }

  versions(tenantId: string, patientId: string): Promise<StoredDemographics[]> {
    return this.db.withTenant(tenantId, async (client) => {
      const { rows } = await client.query<Row>(`SELECT ${COLUMNS} FROM patient_demographics WHERE tenant_id = $1 AND patient_id = $2 ORDER BY version`, [tenantId, patientId]);
      return rows.map(toStored);
    });
  }

  findByRequest(tenantId: string, actor: string, requestId: string): Promise<StoredDemographics | undefined> {
    return this.db.withTenant(tenantId, async (client) => {
      const { rows } = await client.query<Row>(`SELECT ${COLUMNS} FROM patient_demographics WHERE tenant_id = $1 AND created_by = $2 AND creation_request_id = $3`, [
        tenantId,
        actor,
        requestId,
      ]);
      return rows[0] ? toStored(rows[0]) : undefined;
    });
  }

  async insertVersion(tenantId: string, actor: string, input: NewDemographics): Promise<StoredDemographics> {
    try {
      return await this.db.withTenant(
        tenantId,
        async (client: PoolClient) => {
          if (input.newKey) {
            const key = await client.query(
              `INSERT INTO patient_field_keys (tenant_id, patient_id, key_version, wrapped_key, provider, created_by) VALUES ($1, $2, $3, $4, $5, $6)
               ON CONFLICT (tenant_id, patient_id) DO NOTHING`,
              [tenantId, input.patientId, input.newKey.keyVersion, input.newKey.wrapped, input.newKey.provider, actor],
            );
            if ((key.rowCount ?? 0) === 0) throw new FieldKeyRaceError();
          }
          const eventId = newId();
          // `version` is a placeholder: the trigger assigns the real one under the patient's lock, and created_at with it.
          await client.query(
            `INSERT INTO patient_demographics (id, tenant_id, created_by, ledger_event_id, patient_id, version, key_version,
                                               given_name_ct, given_name_nonce, family_name_ct, family_name_nonce, date_of_birth_ct, date_of_birth_nonce,
                                               sex, birth_year, ethnicity, creation_request_id, creation_request_hash)
             VALUES ($1, $2, $3, $4, $5, 1, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15::text[], $16, $17)`,
            [
              input.id,
              tenantId,
              actor,
              eventId,
              input.patientId,
              input.keyVersion,
              input.givenName.ciphertext,
              input.givenName.nonce,
              input.familyName.ciphertext,
              input.familyName.nonce,
              input.dateOfBirth.ciphertext,
              input.dateOfBirth.nonce,
              input.sex,
              input.birthYear,
              input.ethnicity,
              input.request?.id ?? null,
              input.request?.hash ?? null,
            ],
          );
          await this.ledger.appendRecordEvent(client, tenantId, 'patient_demographics', input.id, eventId);
          const { rows } = await client.query<Row>(`SELECT ${COLUMNS} FROM patient_demographics WHERE id = $1 AND tenant_id = $2`, [input.id, tenantId]);
          return toStored(rows[0]!);
        },
        { actor },
      );
    } catch (error) {
      const { code, constraint } = (error ?? {}) as { code?: string; constraint?: string };
      if (code === KEY_UNAVAILABLE) throw new IdentityErasedError();
      if (code === '23505' && constraint === REQUEST_UNIQUE) throw new DemographicsRequestRaceError();
      throw toLedgerError(error);
    }
  }
}
