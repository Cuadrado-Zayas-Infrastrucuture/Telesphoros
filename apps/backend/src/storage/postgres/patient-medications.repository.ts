import { Injectable } from '@nestjs/common';
import type { PatientMedicationDto, PatientMedicationsQuery } from '@telesphoros/shared-types';
import { Database } from '../../db/database';
import { toLedgerError } from '../../ledger/ledger-types';
import { newId } from '../../ledger/ledger-writer';
import { LedgerRecordsRepository } from '../ledger-records.repository';
import {
  medicationDto,
  MedicationRequestRaceError,
  MedicationStaleError,
  type NewMedication,
  PatientMedicationsRepository,
  type StoredMedication,
} from '../patient-medications.repository';
interface Row {
  id: string;
  entry_id: string;
  patient_id: string;
  version: number;
  drug_rxcui: string;
  drug_name: string;
  list_version: string;
  status: PatientMedicationDto['status'];
  start_month: string | null;
  stop_month: string | null;
  source: PatientMedicationDto['source'];
  created_at: Date;
  created_by: string;
  creation_request_hash: string;
}
const columns =
  'id::text, entry_id::text, patient_id::text, version, drug_rxcui, drug_name, list_version, status, start_month, stop_month, source, created_at, created_by, creation_request_hash';
const stored = (r: Row): StoredMedication => ({
  id: r.id,
  entryId: r.entry_id,
  patientId: r.patient_id,
  version: r.version,
  rxcui: r.drug_rxcui,
  name: r.drug_name,
  listVersion: r.list_version,
  status: r.status,
  startMonth: r.start_month,
  stopMonth: r.stop_month,
  source: r.source,
  createdAt: r.created_at.toISOString(),
  createdBy: r.created_by,
  creationRequestHash: r.creation_request_hash,
});
@Injectable()
export class PostgresPatientMedicationsRepository extends PatientMedicationsRepository {
  constructor(
    private readonly db: Database,
    private readonly ledger: LedgerRecordsRepository,
  ) {
    super();
  }
  read(tenant: string, patient: string, query: PatientMedicationsQuery): Promise<PatientMedicationDto[]> {
    return this.db.withTenant(tenant, async (client) => {
      const { rows } = await client.query<Row & { current: boolean }>(
        `WITH versions AS (SELECT ${columns}, max(version) OVER (PARTITION BY entry_id) AS latest
          FROM patient_medications WHERE tenant_id = $1 AND patient_id = $2 AND ($3::uuid IS NULL OR entry_id = $3))
         SELECT *, version = latest AS current FROM versions WHERE version = COALESCE($4, latest) ORDER BY (status = 'stopped'), drug_name, entry_id`,
        [tenant, patient, query.entryId ?? null, query.version ?? null],
      );
      return rows.map((row) => medicationDto(stored(row), row.current));
    });
  }
  findByRequest(tenant: string, actor: string, requestId: string): Promise<StoredMedication | undefined> {
    return this.db.withTenant(tenant, async (client) => {
      const { rows } = await client.query<Row>(`SELECT ${columns} FROM patient_medications WHERE tenant_id=$1 AND created_by=$2 AND creation_request_id=$3`, [
        tenant,
        actor,
        requestId,
      ]);
      return rows[0] ? stored(rows[0]) : undefined;
    });
  }
  async insertVersion(tenant: string, actor: string, data: NewMedication): Promise<StoredMedication> {
    const i = data.input;
    try {
      return await this.db.withTenant(
        tenant,
        async (client) => {
          const eventId = newId();
          const { rows } = await client.query<Row>(
            `INSERT INTO patient_medications (id, tenant_id, created_by, ledger_event_id, patient_id, entry_id, version, drug_rxcui, drug_name, list_version,
            status, start_month, stop_month, source, creation_request_id, creation_request_hash)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING ${columns}`,
            [
              data.id,
              tenant,
              actor,
              eventId,
              data.patientId,
              data.entryId,
              (i.expectedVersion ?? 0) + 1,
              i.rxcui,
              data.name,
              i.listVersion,
              i.status,
              i.startMonth,
              i.stopMonth,
              i.source,
              i.requestId,
              data.requestHash,
            ],
          );
          // The append is last: failure rolls back both row and event.
          await this.ledger.appendRecordEvent(client, tenant, 'patient_medications', data.id, eventId);
          return stored(rows[0]!);
        },
        { actor },
      );
    } catch (error) {
      const { code, constraint } = (error ?? {}) as { code?: string; constraint?: string };
      if (code === '23505' && constraint === 'patient_medications_request_uq') throw new MedicationRequestRaceError();
      if (code === 'MD001') throw new MedicationStaleError();
      throw toLedgerError(error);
    }
  }
}
