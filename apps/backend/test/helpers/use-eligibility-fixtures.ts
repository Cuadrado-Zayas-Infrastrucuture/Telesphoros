import { Client } from 'pg';
import { appendEvent, newId } from '../../src/ledger/ledger-writer';
import type { RecordTable } from '../../src/ledger/ledger-types';

/**
 * TEST AND SEED FIXTURES ONLY (spec 020 E1b, T207). The use-eligibility records have no application writer: no controller, route, service or repository
 * method inserts them (the operator command and the grants API are the later slices E2 and E3). A test or a seed script writes a row the way the
 * ledger fixtures do: as the application role, in a transaction bound to a tenant and an actor, with the row's ledger event appended as the last statement.
 * Synthetic data only: every value here is invented.
 */

/** The fixtures exercise the records, not the ledger watch: this gate never closes. */
const OPEN_GATE = { assertOpen: (): void => undefined };

export type UseRecordTable = Extract<RecordTable, 'use_grants' | 'use_grant_validations' | 'use_withdrawals' | 'use_restrictions' | 'tenant_use_terms'>;
export const USE_RECORD_TABLES: UseRecordTable[] = ['use_grants', 'use_grant_validations', 'use_withdrawals', 'use_restrictions', 'tenant_use_terms'];

export type Row = Record<string, unknown>;

export const HASH = 'a'.repeat(64);
export const PURPOSES = ['clinical-care', 'tenant-quality-improvement', 'research', 'commercial-aggregate', 'payer-program'] as const;
export const CLASSIFICATIONS = ['identifiable', 'coded', 'limited-data-set', 'de-identified'] as const;

const day = 86_400_000;
/** An instant relative to the real clock, as an ISO string. */
export const when = (offsetMs: number): string => new Date(Date.now() + offsetMs).toISOString();
export const DAY = day;

/** A well-formed grant row for `patientId` (jurisdiction ZZ, in force from yesterday for ten years, recorded by `recorder`). Not yet validated. */
export function grantRow(tenantId: string, patientId: string, recorder: string, over: Row = {}): Row {
  return {
    id: newId(),
    tenant_id: tenantId,
    created_by: recorder,
    ledger_event_id: newId(),
    patient_id: patientId,
    purpose: 'research',
    scope: 'syn-program-1',
    jurisdiction: 'ZZ',
    legal_authority: 'authorization',
    form_version: 'syn-form-v1',
    terms_version: 'syn-terms-v1',
    language: 'en',
    effective_from: when(-day),
    expiry_kind: 'date',
    expires_at: when(3650 * day),
    signer: 'syn-signer-1',
    signer_capacity: 'patient',
    authority_evidence_ref: null,
    recorded_by: recorder,
    witness_or_attester: null,
    signed_document_ref: 'syn-doc/signed-1',
    signed_document_sha256: HASH,
    signed_at: when(-day),
    ...over,
  };
}

export const validationRow = (tenantId: string, grantId: string, validator: string, over: Row = {}): Row => ({
  id: newId(),
  tenant_id: tenantId,
  created_by: validator,
  ledger_event_id: newId(),
  grant_id: grantId,
  validated_by: validator,
  ...over,
});

/** `effective_at: null` means "effective when recorded" (the trigger fills it). */
export const withdrawalRow = (tenantId: string, grantId: string, recorder: string, over: Row = {}): Row => ({
  id: newId(),
  tenant_id: tenantId,
  created_by: recorder,
  ledger_event_id: newId(),
  grant_id: grantId,
  effective_at: null,
  recorded_by: recorder,
  ...over,
});

export const restrictionRow = (tenantId: string, patientId: string, recorder: string, over: Row = {}): Row => ({
  id: newId(),
  tenant_id: tenantId,
  created_by: recorder,
  ledger_event_id: newId(),
  patient_id: patientId,
  purpose: 'all',
  effective_from: when(-day),
  effective_until: null,
  reason_code: 'patient-requested',
  ...over,
});

/** Terms in force from yesterday, authorizing every purpose and every classification. */
export const termsRow = (tenantId: string, recorder: string, over: Row = {}): Row => ({
  id: newId(),
  tenant_id: tenantId,
  created_by: recorder,
  ledger_event_id: newId(),
  agreement_ref: `syn-agreement-${newId().slice(0, 8)}`,
  agreement_version: 'v1',
  effective_from: when(-day),
  effective_until: null,
  authorized_purposes: [...PURPOSES],
  authorized_classifications: [...CLASSIFICATIONS],
  de_identification_authorized: false,
  ...over,
});

/** `undefined` leaves the column out of the statement; `null` names it as NULL. */
export function insertSql(table: UseRecordTable, row: Row): [string, unknown[]] {
  const keys = Object.keys(row).filter((k) => row[k] !== undefined);
  return [`INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING created_at::text AS created_at`, keys.map((k) => row[k])];
}

export interface Written {
  id: string;
  /** The recording instant the database set, as text with microseconds, usable as a timestamptz parameter without loss. */
  createdAt: string;
}

/** Inserts the row and appends its ledger event on a client that is already in a bound transaction. Nothing is committed. */
export async function insertUseRecord(client: Client, table: UseRecordTable, row: Row): Promise<Written> {
  const [sql, values] = insertSql(table, row);
  const inserted = await client.query<{ created_at: string }>(sql, values);
  await appendEvent(OPEN_GATE, row.tenant_id as string, client, table, row.id as string, row.ledger_event_id as string);
  return { id: row.id as string, createdAt: inserted.rows[0]!.created_at };
}

/** One committed record: its own transaction as the application role, bound to the row's tenant and actor. */
export async function writeUseRecord(appUrl: string, table: UseRecordTable, row: Row): Promise<Written> {
  const client = new Client({ connectionString: appUrl, application_name: `use-fixture-${table}` });
  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [row.tenant_id]);
    await client.query(`SELECT set_config('app.current_actor', $1, true)`, [row.created_by]);
    const written = await insertUseRecord(client, table, row);
    await client.query('COMMIT');
    return written;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined); // intentional: the transaction may already be gone
    throw error;
  } finally {
    await client.end();
  }
}

export interface Question {
  patient: string;
  purpose: string;
  scope?: string;
  classification?: string;
  factKind?: string;
  factId: string;
  /** Any instant; a timestamptz as text or an ISO string. */
  at: string;
}

export interface Answer {
  eligible: boolean;
  reason_codes: string[];
  evidence_ids: string[];
  legal_authority: string | null;
  data_classification: string | null;
  policy_version: string;
}

/** Asks the policy as the application role in a fresh, bound transaction (no lock: the caller chooses `at`). */
export async function askUse(appUrl: string, tenantId: string, q: Question, actor = 'syn-asker'): Promise<Answer> {
  const client = new Client({ connectionString: appUrl, application_name: 'use-fixture-ask' });
  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [tenantId]);
    await client.query(`SELECT set_config('app.current_actor', $1, true)`, [actor]);
    const result = await client.query<Answer>(`SELECT * FROM use_eligibility($1, $2, $3, $4, $5, $6, $7, $8)`, [
      tenantId,
      q.patient,
      q.purpose,
      q.scope ?? 'syn-program-1',
      q.classification ?? 'identifiable',
      q.factKind ?? 'capture',
      q.factId,
      q.at,
    ]);
    await client.query('COMMIT');
    return result.rows[0]!;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined); // intentional: the transaction may already be gone
    throw error;
  } finally {
    await client.end();
  }
}
