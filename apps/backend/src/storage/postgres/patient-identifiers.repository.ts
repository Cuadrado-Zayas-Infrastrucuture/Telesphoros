import { Injectable } from '@nestjs/common';
import { Database } from '../../db/database';
import {
  type DuplicateCandidate,
  IdentifierInUseError,
  IdentifierRequestReusedError,
  type IdentifierRecord,
  PatientIdentifiersRepository,
  type RegistrationRequest,
} from '../patient-identifiers.repository';
import type { Page, PageRequest } from '../records';

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
  id: r.id,
  tenantId: r.tenant_id,
  patientId: r.patient_id,
  system: r.system,
  digest: r.value_digest,
  keyVersion: r.key_version,
  status: r.status,
  createdBy: r.created_by,
  createdAt: r.created_at,
  withdrawnAt: r.withdrawn_at,
});

/** Every query names `tenant_id` AND runs under row-level security. The digest is read only to compare; it is never logged. */
@Injectable()
export class PostgresPatientIdentifiersRepository extends PatientIdentifiersRepository {
  constructor(private readonly db: Database) {
    super();
  }

  async add(
    tenantId: string,
    actor: string,
    input: { patientId: string; system: string; digest: Buffer; keyVersion: number; request?: RegistrationRequest },
  ): Promise<IdentifierRecord> {
    const result = await this.db.withTenant(
      tenantId,
      async (client): Promise<IdentifierRecord | 'in-use' | 'reused'> => {
        // A repeat of a registration that went through: the identifier stored under this person's retry id, if its fingerprint is the same.
        const replay = async (): Promise<IdentifierRecord | 'reused' | undefined> => {
          if (!input.request) return undefined;
          const { rows } = await client.query<Row & { creation_request_hash: string }>(
            `SELECT ${COLUMNS}, creation_request_hash FROM patient_identifiers WHERE tenant_id = $1 AND created_by = $2 AND creation_request_id = $3`,
            [tenantId, actor, input.request.id],
          );
          if (!rows[0]) return undefined;
          return rows[0].creation_request_hash === input.request.hash ? toRecord(rows[0]) : 'reused';
        };
        const prior = await replay();
        if (prior) return prior;
        // A savepoint, so the refused insert does not abort the transaction that also records the possible-duplicate flag.
        await client.query('SAVEPOINT add_identifier');
        try {
          const { rows } = await client.query<Row>(
            `INSERT INTO patient_identifiers (tenant_id, patient_id, system, value_digest, key_version, created_by, creation_request_id, creation_request_hash)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING ${COLUMNS}`,
            [tenantId, input.patientId, input.system, input.digest, input.keyVersion, actor, input.request?.id ?? null, input.request?.hash ?? null],
          );
          return toRecord(rows[0]!);
        } catch (error) {
          const { code, constraint } = error as { code?: string; constraint?: string };
          if (code !== '23505' || (constraint !== 'patient_identifiers_active_uq' && constraint !== 'patient_identifiers_creation_request_uq')) throw error;
          await client.query('ROLLBACK TO SAVEPOINT add_identifier');
          // A concurrent repeat of this very request can meet the number's index before the request id's: either way, the question is whether the winner is this request.
          const raced = await replay();
          if (raced) return raced;
          if (constraint === 'patient_identifiers_creation_request_uq') throw error;
          const holder = await client.query<{ patient_id: string }>(
            `SELECT patient_id::text AS patient_id FROM patient_identifiers WHERE tenant_id = $1 AND system = $2 AND value_digest = $3 AND status = 'active'`,
            [tenantId, input.system, input.digest],
          );
          const other = holder.rows[0]?.patient_id;
          // Another patient holds this number: a possible duplicate, one flag per unordered pair. Nothing about the number is kept.
          if (other && other !== input.patientId) {
            await client.query(
              `INSERT INTO patient_duplicate_flags (tenant_id, patient_id, other_patient_id, system, flagged_by)
               VALUES ($1, LEAST($2::uuid, $3::uuid), GREATEST($2::uuid, $3::uuid), $4, $5) ON CONFLICT ON CONSTRAINT patient_duplicate_flags_pair_uq DO NOTHING`,
              [tenantId, input.patientId, other, input.system, actor],
            );
          }
          return 'in-use';
        }
      },
      { actor },
    );
    // Thrown after the transaction committed, so the flag is kept while the answer is still 409.
    if (result === 'in-use') throw new IdentifierInUseError();
    if (result === 'reused') throw new IdentifierRequestReusedError();
    return result;
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
        // The patient's group: itself, or its root and the root's other aliases once merged (M2.1c-2). Identifiers are never copied or moved.
        `SELECT ${COLUMNS} FROM patient_identifiers WHERE tenant_id = $1 AND patient_id IN (SELECT patient_group_ids($1, $2::uuid)) AND system = $3 AND value_digest = $4 AND status = 'active'
          ORDER BY (patient_id = $2::uuid) DESC, seq LIMIT 1`,
        [tenantId, patientId, system, digest],
      );
      return rows[0] ? toRecord(rows[0]) : undefined;
    });
  }

  listDuplicates(tenantId: string, { offset, limit }: PageRequest): Promise<Page<DuplicateCandidate>> {
    return this.db.withTenant(tenantId, async (client) => {
      const { rows } = await client.query<{
        patient_id: string | null;
        patient_label: string;
        other_id: string;
        other_label: string;
        system: string;
        flagged_at: Date;
        total: number;
      }>(
        `WITH edges AS MATERIALIZED (SELECT * FROM patient_alias_edges($1)),
              live AS MATERIALIZED (
                SELECT f.seq, f.patient_id, f.other_patient_id, f.system, f.flagged_at, a.label AS patient_label, b.label AS other_label
                  FROM patient_duplicate_flags f
                  JOIN patients a ON a.id = f.patient_id AND a.tenant_id = f.tenant_id AND a.deleted_at IS NULL
                  JOIN patients b ON b.id = f.other_patient_id AND b.tenant_id = f.tenant_id AND b.deleted_at IS NULL
                 WHERE f.tenant_id = $1
                   -- dismissed: someone declined to merge this pair, in either direction
                   AND NOT EXISTS (SELECT 1 FROM patient_merge_proposals p JOIN patient_merge_decisions d ON d.proposal_id = p.id AND d.tenant_id = p.tenant_id
                                    WHERE p.tenant_id = f.tenant_id AND p.kind = 'merge' AND d.decision = 'declined'
                                      AND ((p.source_patient_id = f.patient_id AND p.target_patient_id = f.other_patient_id) OR (p.source_patient_id = f.other_patient_id AND p.target_patient_id = f.patient_id)))
                   -- already one group (merged directly, or both merged into the same root)
                   AND COALESCE((SELECT target_patient_id FROM edges WHERE source_patient_id = f.patient_id), f.patient_id)
                       <> COALESCE((SELECT target_patient_id FROM edges WHERE source_patient_id = f.other_patient_id), f.other_patient_id)),
              page AS (SELECT * FROM live ORDER BY seq DESC LIMIT $2 OFFSET $3)
         SELECT page.patient_id::text AS patient_id, page.patient_label, page.other_patient_id::text AS other_id, page.other_label, page.system, page.flagged_at, totals.total
           FROM (SELECT count(*)::int AS total FROM live) totals LEFT JOIN page ON true ORDER BY page.seq DESC`,
        [tenantId, limit, offset],
      );
      return {
        items: rows.flatMap((r) =>
          r.patient_id === null
            ? []
            : [{ patientId: r.patient_id, patientLabel: r.patient_label, otherPatientId: r.other_id, otherPatientLabel: r.other_label, system: r.system, flaggedAt: r.flagged_at }],
        ),
        total: rows[0]!.total,
      };
    });
  }
}
