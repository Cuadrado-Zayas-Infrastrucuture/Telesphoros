import { currentRequestId } from '../../auth/authority-context';
import type { AttemptIdentity, UploadAttempt, UploadState } from '../upload-attempt';
import { sameAttempt } from '../upload-attempt';
import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type { ReportStatus, ReportType } from '@telesphoros/shared-types';
import { Database } from '../../db/database';
import { IntegrityError, toStorageError } from '../errors';
import type { Page, PageRequest, ReportRecord } from '../records';
import { type ReportFilter, ReportsRepository } from '../reports.repository';
import { retryOnConflict } from './retry-conflict';

interface ReportRow {
  upload_revision: string;
  id: string;
  tenant_id: string;
  created_by: string;
  patient_id: string;
  type: ReportType;
  original_filename: string;
  size_bytes: string; // bigint arrives as a string
  status: ReportStatus;
  creation_request_id: string | null;
  creation_request_hash: string | null;
  deleted_at: Date | null;
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
  'upload_revision, id, tenant_id, created_by, patient_id, type, original_filename, size_bytes, status, content_type, sha256, storage_key, uploaded_at, object_version, upload_requested_by, uploaded_by, created_at, updated_at, creation_request_id, creation_request_hash, deleted_at';

const INSERT = `INSERT INTO reports (id, tenant_id, created_by, patient_id, type, original_filename, size_bytes, status,
  content_type, sha256, storage_key, uploaded_at, object_version, upload_requested_by, uploaded_by, created_at, updated_at,
  creation_request_id, creation_request_hash)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)`;
const insertValues = (record: ReportRecord) => [
  record.id, record.tenantId, record.createdBy, record.patientId, record.type, record.filename, record.sizeBytes,
  record.status, record.contentType ?? null, record.sha256 ?? null, record.storageKey ?? null,
  record.uploadedAt ?? null, record.objectVersion ?? null, record.uploadRequestedBy ?? null, record.uploadedBy ?? null,
  record.createdAt, record.updatedAt, record.creationRequestId ?? null, record.creationRequestHash ?? null,
];

const toRecord = (row: ReportRow): ReportRecord => ({
  id: row.id,
  uploadRevision: row.upload_revision,
  deletedAt: row.deleted_at?.toISOString() ?? null,
  tenantId: row.tenant_id,
  createdBy: row.created_by,
  patientId: row.patient_id,
  type: row.type,
  filename: row.original_filename,
  sizeBytes: Number(row.size_bytes),
  status: row.status,
  ...(row.creation_request_id ? {
    creationRequestId: row.creation_request_id,
    creationRequestHash: row.creation_request_hash,
  } : {}),
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

/**
 * Holds the report's patient against a soft delete until this transaction ends, and refuses a patient that is already gone.
 *
 * The service reads the patient in one transaction and inserts the report in another. The patient's soft-delete trigger asks "are there live reports?" under
 * READ COMMITTED, so it cannot see a report that has not committed, and the report's foreign key takes only a KEY SHARE lock, which a soft delete (an update that
 * does not touch the key) does not conflict with. FOR SHARE does conflict with that update: a delete that arrives after this lock waits for this transaction,
 * then sees the committed report and is refused; a delete that committed before it is seen here and refuses the report. Without the lock both could commit and
 * leave a live report on a deleted patient.
 */
async function holdPatient(client: PoolClient, record: ReportRecord): Promise<void> {
  const held = await client.query('SELECT 1 FROM patients WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL FOR SHARE', [record.patientId, record.tenantId]);
  if (held.rowCount === 0) throw new IntegrityError('reports_patient_gone');
}

@Injectable()
export class PostgresReportsRepository extends ReportsRepository {
  constructor(private readonly db: Database) {
    super();
  }

  list(tenantId: string, { offset, limit }: PageRequest, filter: ReportFilter): Promise<Page<ReportRecord>> {
    return this.db.withTenant(tenantId, async (client) => {
      // `$2::uuid IS NULL OR patient_id = $2` keeps ONE static query text for both filtered and unfiltered lists.
      // The patient filter means the patient's whole group (a merged patient and the one it was merged into), so a bookmark to either finds everything.
      const where = 'tenant_id = $1 AND deleted_at IS NULL AND ($2::uuid IS NULL OR patient_id IN (SELECT patient_group_ids($1, $2::uuid)))';
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
      await this.db.withTenant(record.tenantId, async (client) => {
        await holdPatient(client, record);
        await client.query(INSERT, insertValues(record));
      });
    } catch (error) {
      throw toStorageError(error);
    }
  }

  async insertOrReplay(record: ReportRecord): Promise<ReportRecord> {
    if (!record.creationRequestId || !record.creationRequestHash) throw new Error('Missing report creation identity');
    try {
      return await this.db.withTenant(record.tenantId, async client => {
        await holdPatient(client, record);
        const inserted = await client.query<ReportRow>(`${INSERT}
          ON CONFLICT ON CONSTRAINT reports_creation_request_uq DO NOTHING RETURNING ${COLUMNS}`, insertValues(record));
        if (inserted.rows[0]) return toRecord(inserted.rows[0]);
        // Separate READ COMMITTED statement sees the winner after a concurrent INSERT finishes.
        // Do not use a no-op UPDATE: it would fire evidence guards and alter an existing row on replay.
        const existing = await client.query<ReportRow>(`SELECT ${COLUMNS} FROM reports
          WHERE tenant_id = $1 AND created_by = $2 AND creation_request_id = $3`,
        [record.tenantId, record.createdBy, record.creationRequestId]);
        const prior = existing.rows[0];
        if (!prior || prior.deleted_at || prior.creation_request_hash !== record.creationRequestHash) {
          throw new IntegrityError('reports_creation_request_uq');
        }
        return toRecord(prior);
      });
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

  async declareAttempt(a: UploadAttempt, expectedRevision: string) {
    return retryOnConflict(() => this.db.withTenant(a.tenantId, async c => {
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [a.runId]);
      // The report row BEFORE the run row, the order commitAttempt takes them in. Declare used to take the run row first, so a declaration and a commit for the same report could each
      // hold one and wait for the other (40P01). Every transaction that holds a run row now already holds its report row.
      await c.query('SELECT 1 FROM reports WHERE tenant_id=$1 AND id=$2 AND deleted_at IS NULL FOR UPDATE', [a.tenantId, a.reportId]);
      const prior = await c.query('SELECT * FROM report_upload_attempts WHERE tenant_id=$1 AND report_id=$2 AND principal=$3 AND request_id=$4', [a.tenantId,a.reportId,a.principal,a.requestId]);
      if (prior.rows[0]) { const p=attemptRecord(prior.rows[0]); return sameAttempt(p,a) && !['cancelled','cleanup','cleaned'].includes(p.state) ? p : undefined; }
      await c.query('INSERT INTO report_upload_runs(run_id,tenant_id) VALUES($1,$2) ON CONFLICT DO NOTHING', [a.runId,a.tenantId]);
      const quota = await c.query('UPDATE report_upload_runs SET reserved_bytes=reserved_bytes+$3,updated_at=now() WHERE run_id=$1 AND tenant_id=$2 AND NOT cleanup_stalled AND reserved_bytes+$3<=104857600 RETURNING run_id', [a.runId,a.tenantId,a.sizeBytes]);
      if (!quota.rowCount) return undefined;
      const changed = await c.query(`UPDATE reports SET storage_key=$3,content_type=$4,sha256=$5,upload_requested_by=COALESCE(upload_requested_by,$6),updated_at=now()
        WHERE id=$1 AND tenant_id=$2 AND upload_revision=$7 AND uploaded_at IS NULL AND deleted_at IS NULL AND type=$8 AND patient_id=$9 AND size_bytes=$10 RETURNING upload_revision`,
      [a.reportId,a.tenantId,a.key,a.contentType,a.sha256,a.principal,expectedRevision,a.type,a.patientId,a.sizeBytes]);
      if (!changed.rowCount) { await c.query('UPDATE report_upload_runs SET reserved_bytes=reserved_bytes-$3 WHERE run_id=$1 AND tenant_id=$2',[a.runId,a.tenantId,a.sizeBytes]); return undefined; }
      const result=await c.query(`INSERT INTO report_upload_attempts(id,request_id,run_id,tenant_id,report_id,patient_id,principal,revision,type,size_bytes,content_type,sha256,storage_key,state,lease_until,declaration_revision)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'declared',now()+interval '1 hour',$14) RETURNING *`,
      [a.id,a.requestId,a.runId,a.tenantId,a.reportId,a.patientId,a.principal,changed.rows[0].upload_revision,a.type,a.sizeBytes,a.contentType,a.sha256,a.key,a.declarationRevision]);
      return attemptRecord(result.rows[0]);
    }));
  }
  async findAttempt(i: AttemptIdentity) { return this.db.withTenant(i.tenantId, async c => {
    const r=await c.query(`SELECT * FROM report_upload_attempts WHERE ${ATTEMPT_WHERE}`, identityValues(i)); return r.rows[0] ? attemptRecord(r.rows[0]) : undefined;
  }); }
  async beginAttempt(i: AttemptIdentity, writer: string) { return this.db.withTenant(i.tenantId, async c => {
    const r=await c.query(`UPDATE report_upload_attempts a SET state='intaking',writer=$6,lease_until=now()+interval '1 hour',updated_at=now() WHERE ${ATTEMPT_WHERE} AND state='declared' AND writer IS NULL AND lease_until>now()
      AND EXISTS(SELECT 1 FROM reports r WHERE r.id=a.report_id AND r.tenant_id=a.tenant_id AND r.deleted_at IS NULL AND r.uploaded_at IS NULL AND r.upload_revision=a.revision)`, [...identityValues(i),writer]); return !!r.rowCount;
  }); }
  async validateAttempt(i: AttemptIdentity, writer: string) { return this.db.withTenant(i.tenantId,async c=>{
    const r=await c.query(`UPDATE report_upload_attempts SET validated=true,lease_until=now()+interval '1 hour',updated_at=now() WHERE ${ATTEMPT_WHERE} AND writer=$6 AND state='intaking' AND lease_until>now()`,[...identityValues(i),writer]);return !!r.rowCount;
  }); }
  async settleAttempt(i: AttemptIdentity, writer: string, state: UploadState, version?: string) { return this.db.withTenant(i.tenantId, async c => {
    const r=await c.query(`UPDATE report_upload_attempts SET state=CASE WHEN state='cancelling' THEN CASE WHEN $7='unresolved' THEN 'unresolved' ELSE 'cancelled' END ELSE $7 END,
      object_version=COALESCE(object_version,$8),writer=NULL,updated_at=now() WHERE ${ATTEMPT_WHERE} AND writer=$6 AND state IN ('intaking','cancelling')`, [...identityValues(i),writer,state,version??null]); return !!r.rowCount;
  }); }
  async recoverAttempt(i: AttemptIdentity, version: string) { return this.db.withTenant(i.tenantId,async c=>{
    const r=await c.query(`UPDATE report_upload_attempts SET state=CASE WHEN cancel_requested THEN 'cancelled' ELSE 'stored' END,object_version=COALESCE(object_version,$6),updated_at=now()
      WHERE ${ATTEMPT_WHERE} AND state='unresolved' AND validated AND writer IS NULL AND (object_version IS NULL OR object_version=$6)`,[...identityValues(i),version]);return !!r.rowCount;
  }); }
  async cancelAttempt(i: AttemptIdentity) { return this.db.withTenant(i.tenantId, async c => {
    await c.query(`UPDATE report_upload_attempts SET cancel_requested=true,state=CASE WHEN writer IS NOT NULL THEN 'cancelling' WHEN state='unresolved' THEN 'unresolved' ELSE 'cancelled' END,updated_at=now()
      WHERE ${ATTEMPT_WHERE} AND state NOT IN ('committed','cleanup','cleaned')`, identityValues(i));
    const r=await c.query(`SELECT * FROM report_upload_attempts WHERE ${ATTEMPT_WHERE}`,identityValues(i)); return r.rows[0]?attemptRecord(r.rows[0]):undefined;
  }); }
  async commitAttempt(i: AttemptIdentity) { return retryOnConflict(() => this.db.withTenant(i.tenantId, async c => {
    const report=await c.query('SELECT * FROM reports WHERE tenant_id=$1 AND id=$2 AND deleted_at IS NULL FOR UPDATE',[i.tenantId,i.reportId]);
    const found=await c.query(`SELECT * FROM report_upload_attempts WHERE ${ATTEMPT_WHERE} FOR UPDATE`,identityValues(i));
    if (!found.rows[0] || !report.rows[0]) return false;
    const a=attemptRecord(found.rows[0]); const r=report.rows[0];
    if(a.state==='committed') return r.storage_key===a.key && r.object_version===a.version && r.sha256===a.sha256;
    if(a.cancelRequested||a.state!=='stored'||!a.validated||!a.version||a.writer) return false;
    const pin=await c.query(`UPDATE reports SET uploaded_at=now(),uploaded_by=$3,object_version=$4,updated_at=now()
      WHERE tenant_id=$1 AND id=$2 AND deleted_at IS NULL AND uploaded_at IS NULL AND upload_revision=$5 AND patient_id=$6 AND type=$7 AND size_bytes=$8
      AND content_type=$9 AND sha256=$10 AND storage_key=$11 AND EXISTS(SELECT 1 FROM report_upload_attempts WHERE tenant_id=$1 AND id=$12 AND state='stored' AND lease_until>now())`,
    [i.tenantId,i.reportId,a.principal,a.version,a.revision,a.patientId,a.type,a.sizeBytes,a.contentType,a.sha256,a.key,a.id]);
    if(!pin.rowCount) return false;
    // The follow-up (a re-check of the stored file) is recorded in THIS transaction: a commit that rolls back leaves no event, and one that commits cannot lose it.
    await c.query('SELECT outbox_append($1, $2, $3)',['report.file-committed',i.reportId,currentRequestId() ?? null]); // the id of the request that is committing, so the stored-file check can be traced to it
    await c.query("UPDATE report_upload_attempts SET state='committed',updated_at=now() WHERE tenant_id=$1 AND id=$2 AND state='stored'",[i.tenantId,a.id]);
    await c.query('UPDATE report_upload_runs SET reserved_bytes=reserved_bytes-$3,updated_at=now() WHERE tenant_id=$1 AND run_id=$2',[i.tenantId,a.runId,a.sizeBytes]); return true;
  })); }
  async runStatus(tenantId:string,runId:string){return this.db.withTenant(tenantId,async c=>{const r=(await c.query(`SELECT reserved_bytes,last_reconciled_at,cleanup_stalled,(SELECT count(*) FROM report_upload_attempts WHERE tenant_id=$1 AND run_id=$2 AND state NOT IN ('committed','cleaned')) AS pending_count FROM report_upload_runs WHERE tenant_id=$1 AND run_id=$2`,[tenantId,runId])).rows[0];return {pendingBytes:Number(r?.reserved_bytes??0),pendingCount:Number(r?.pending_count??0),lastReconciledAt:r?.last_reconciled_at?.toISOString()??null,cleanupStalled:r?.cleanup_stalled??false};});}
  async recordReconciliation(tenantId:string,runId:string,success:boolean){await this.db.withTenant(tenantId,async c=>{await c.query('UPDATE report_upload_runs SET cleanup_stalled=NOT $3,last_reconciled_at=CASE WHEN $3 THEN now() ELSE last_reconciled_at END,updated_at=now() WHERE tenant_id=$1 AND run_id=$2',[tenantId,runId,success]);});}
  async runAttempts(tenantId: string,runId: string) {return this.db.withTenant(tenantId,async c=>{const r=await c.query('SELECT * FROM report_upload_attempts WHERE tenant_id=$1 AND run_id=$2 LIMIT 10001',[tenantId,runId]);if(r.rows.length>10000)throw new Error('Incomplete attempt inventory.');return r.rows.map(attemptRecord);});}
  async reportAttempts(tenantId: string, reportId: string) {return this.db.withTenant(tenantId,async c=>{const r=await c.query('SELECT * FROM report_upload_attempts WHERE tenant_id=$1 AND report_id=$2 LIMIT 1001',[tenantId,reportId]);if(r.rows.length>1000)throw new Error('Incomplete attempt inventory.');return r.rows.map(attemptRecord);});}
  async hasAttempts(tenantId: string, reportId: string) {return this.db.withTenant(tenantId,async c=>(await c.query('SELECT EXISTS(SELECT 1 FROM report_upload_attempts WHERE tenant_id=$1 AND report_id=$2) AS found',[tenantId,reportId])).rows[0].found===true);}
  async sweepCandidates(tenantId: string, runId: string) { return this.db.withTenant(tenantId,async c => {
    const r=await c.query("SELECT * FROM report_upload_attempts WHERE tenant_id=$1 AND run_id=$2 AND state NOT IN ('committed','cleaned') ORDER BY created_at LIMIT 101",[tenantId,runId]);
    if(r.rows.length>100) throw new Error('Incomplete cleanup candidate inventory.'); return r.rows.map(attemptRecord);
  }); }
  async referenced(tenantId: string,key: string,version: string) { return this.db.withTenant(tenantId,async c => {
    const r=await c.query(`SELECT EXISTS(SELECT 1 FROM reports WHERE tenant_id=$1 AND storage_key=$2 AND uploaded_at IS NOT NULL AND (object_version=$3 OR object_version IS NULL))
      OR EXISTS(SELECT 1 FROM report_captures WHERE tenant_id=$1 AND text_storage_key=$2) AS protected`,[tenantId,key,version]);return !!r.rows[0].protected;
  }); }
  async claimCleanup(tenantId: string,id: string,graceSeconds: number) { return this.db.withTenant(tenantId,async c => {
    const r=await c.query(`UPDATE report_upload_attempts a SET state='cleanup',writer=NULL,updated_at=now() WHERE tenant_id=$1 AND id=$2 AND state NOT IN ('committed','cleaned')
      AND (state IN ('cancelled','cleanup') OR lease_until + $3 * interval '1 second'<=now())
      AND (writer IS NULL OR lease_until + $3 * interval '1 second'<=now())
      AND NOT EXISTS(SELECT 1 FROM reports r WHERE r.tenant_id=$1 AND r.storage_key=a.storage_key AND r.uploaded_at IS NOT NULL)
      AND NOT EXISTS(SELECT 1 FROM report_captures c WHERE c.tenant_id=$1 AND c.text_storage_key=a.storage_key)`,[tenantId,id,graceSeconds]);return !!r.rowCount;
  }); }
  async finishCleanup(tenantId: string,id: string) { await this.db.withTenant(tenantId,async c => {
    const r=await c.query("UPDATE report_upload_attempts SET state='cleaned',updated_at=now() WHERE tenant_id=$1 AND id=$2 AND state='cleanup' RETURNING run_id,size_bytes",[tenantId,id]);
    if(r.rows[0]) await c.query('UPDATE report_upload_runs SET reserved_bytes=reserved_bytes-$3,updated_at=now() WHERE tenant_id=$1 AND run_id=$2',[tenantId,r.rows[0].run_id,r.rows[0].size_bytes]);
  }); }
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

const ATTEMPT_WHERE='tenant_id=$1 AND report_id=$2 AND id=$3 AND principal=$4 AND revision=$5';
const identityValues=(i: AttemptIdentity)=>[i.tenantId,i.reportId,i.id,i.principal,i.revision];
const attemptRecord=(r: Record<string, unknown>): UploadAttempt=>({
 id:r.id as string, requestId:r.request_id as string,runId:r.run_id as string,tenantId:r.tenant_id as string,reportId:r.report_id as string,patientId:r.patient_id as string,principal:r.principal as string,
 revision:r.revision as string,declarationRevision:r.declaration_revision as string,type:r.type as UploadAttempt['type'],sizeBytes:Number(r.size_bytes),contentType:r.content_type as string,sha256:r.sha256 as string,key:r.storage_key as string,
 cancelRequested:r.cancel_requested as boolean,validated:r.validated as boolean,state:r.state as UploadState,version:r.object_version as string|null,writer:r.writer as string|null,leaseUntil:(r.lease_until as Date).toISOString(),createdAt:(r.created_at as Date).toISOString(),
});
