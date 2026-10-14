import { randomUUID } from 'node:crypto';
import type { AttemptIdentity, UploadAttempt, UploadState } from './upload-attempt';
import { sameAttempt } from './upload-attempt';
import { Injectable } from '@nestjs/common';
import { IntegrityError } from './errors';
import { byCreatedAt, type Page, type PageRequest, type ReportRecord, slicePage } from './records';

export interface ReportFilter {
  patientId?: string;
}

/** See PatientsRepository: every method is tenant-scoped. */
export abstract class ReportsRepository {
  abstract list(tenantId: string, page: PageRequest, filter: ReportFilter): Promise<Page<ReportRecord>>;
  abstract findById(tenantId: string, id: string): Promise<ReportRecord | undefined>;
  abstract countByPatient(tenantId: string, patientId: string): Promise<number>;
  abstract insert(record: ReportRecord): Promise<void>;
  /** Atomic keyed creation: replay the same original metadata; conflicting or deleted identities refuse. */
  abstract insertOrReplay(record: ReportRecord): Promise<ReportRecord>;
  /** Changes only what a person may edit: type, file name, status. Never the stored file's identity. */
  abstract update(record: ReportRecord): Promise<void>;
  abstract declareAttempt(attempt: UploadAttempt, expectedRevision: string): Promise<UploadAttempt | undefined>;
  abstract findAttempt(identity: AttemptIdentity): Promise<UploadAttempt | undefined>;
  abstract beginAttempt(identity: AttemptIdentity, writer: string): Promise<boolean>;
  abstract validateAttempt(identity: AttemptIdentity, writer: string): Promise<boolean>;
  abstract settleAttempt(identity: AttemptIdentity, writer: string, state: UploadState, version?: string): Promise<boolean>;
  abstract recoverAttempt(identity: AttemptIdentity, version: string): Promise<boolean>;
  abstract cancelAttempt(identity: AttemptIdentity): Promise<UploadAttempt | undefined>;
  abstract commitAttempt(identity: AttemptIdentity): Promise<boolean>;
  abstract runStatus(tenantId:string,runId:string):Promise<{pendingBytes:number;pendingCount:number;lastReconciledAt:string|null;cleanupStalled:boolean}>;
  abstract recordReconciliation(tenantId:string,runId:string,success:boolean):Promise<void>;
  abstract runAttempts(tenantId: string, runId: string): Promise<UploadAttempt[]>;
  /** Every intake attempt of one report (any state); refuses rather than truncates. */
  abstract reportAttempts(tenantId: string, reportId: string): Promise<UploadAttempt[]>;
  /** True when the report has ever had an intake attempt: the legacy direct-upload routes then refuse it. */
  abstract hasAttempts(tenantId: string, reportId: string): Promise<boolean>;
  abstract sweepCandidates(tenantId: string, runId: string): Promise<UploadAttempt[]>;
  abstract claimCleanup(tenantId: string, id: string, graceSeconds: number): Promise<boolean>;
  abstract finishCleanup(tenantId: string, id: string): Promise<void>;
  abstract referenced(tenantId: string, key: string, version: string): Promise<boolean>;
  abstract delete(tenantId: string, id: string): Promise<boolean>;
}

@Injectable()
export class InMemoryReportsRepository extends ReportsRepository {
  private readonly reconciliation=new Map<string,{lastReconciledAt:string|null;cleanupStalled:boolean}>();
  private readonly attempts = new Map<string, UploadAttempt>();
  private readonly rows = new Map<string, ReportRecord>();
  // Keep a reservation even when the live row is deleted, like PostgreSQL's retained soft-delete row.
  private readonly creationRequests = new Map<string, { id: string; hash: string }>();

  private owned(tenantId: string) {
    return [...this.rows.values()].filter((row) => row.tenantId === tenantId && !row.deletedAt);
  }

  async list(tenantId: string, page: PageRequest, filter: ReportFilter) {
    const rows = this.owned(tenantId).filter((row) => !filter.patientId || row.patientId === filter.patientId);
    return slicePage(rows.sort(byCreatedAt), page);
  }
  async findById(tenantId: string, id: string) {
    const row = this.rows.get(id);
    return row && row.tenantId === tenantId && !row.deletedAt ? { ...row } : undefined;
  }
  async countByPatient(tenantId: string, patientId: string) {
    return this.owned(tenantId).filter((row) => row.patientId === patientId).length;
  }
  async insert(record: ReportRecord) {
    if (record.creationRequestId && record.creationRequestHash) {
      const key = JSON.stringify([record.tenantId, record.createdBy, record.creationRequestId]);
      if (this.creationRequests.has(key)) throw new IntegrityError('reports_creation_request_uq');
      this.creationRequests.set(key, { id: record.id, hash: record.creationRequestHash });
    }
    this.rows.set(record.id, { ...record, deletedAt: record.deletedAt ?? null, uploadRevision: record.uploadRevision ?? randomUUID() });
  }
  async insertOrReplay(record: ReportRecord): Promise<ReportRecord> {
    if (!record.creationRequestId || !record.creationRequestHash) throw new Error('Missing report creation identity');
    const key = JSON.stringify([record.tenantId, record.createdBy, record.creationRequestId]);
    const prior = this.creationRequests.get(key);
    if (prior) {
      const current = this.rows.get(prior.id);
      if (!current || current.deletedAt || prior.hash !== record.creationRequestHash) throw new IntegrityError('reports_creation_request_uq');
      return { ...current };
    }
    // insert reserves synchronously before returning its promise; concurrent calls cannot both create a row.
    await this.insert(record);
    return { ...this.rows.get(record.id)! };
  }
  async update(record: ReportRecord) {
    const row = this.rows.get(record.id);
    if (!row || row.tenantId !== record.tenantId || row.deletedAt) return;
    if (row.uploadedAt && row.type !== record.type) throw new IntegrityError('reports_uploaded_type');
    this.rows.set(record.id, { ...row, type: record.type, filename: record.filename, status: record.status, updatedAt: record.updatedAt, uploadRevision: row.type !== record.type ? randomUUID() : row.uploadRevision });
  }
  async declareAttempt(a: UploadAttempt, expectedRevision: string) {
    const prior = [...this.attempts.values()].find(x => x.tenantId === a.tenantId && x.reportId === a.reportId && x.principal === a.principal && x.requestId === a.requestId);
    if (prior) return sameAttempt(prior, a) && !['cancelled','cleanup','cleaned'].includes(prior.state) ? { ...prior } : undefined;
    const r = this.rows.get(a.reportId);
    if (!r || r.tenantId !== a.tenantId || r.deletedAt || r.uploadedAt || r.uploadRevision !== expectedRevision || r.type !== a.type || r.patientId !== a.patientId || r.sizeBytes !== a.sizeBytes) return undefined;
    if ([...this.attempts.values()].some(x => x.runId === a.runId && x.tenantId !== a.tenantId)) return undefined;
    if(this.reconciliation.get(JSON.stringify([a.tenantId,a.runId]))?.cleanupStalled)return undefined;
    const pending = [...this.attempts.values()].filter(x => x.tenantId === a.tenantId && x.runId === a.runId && !['committed','cleaned'].includes(x.state)).reduce((n,x) => n+x.sizeBytes,0);
    if (pending + a.sizeBytes > 104857600) return undefined;
    const revision = randomUUID(); a = { ...a, revision };
    this.rows.set(r.id, { ...r, uploadRevision: revision, storageKey: a.key, contentType: a.contentType, sha256: a.sha256, uploadRequestedBy: r.uploadRequestedBy ?? a.principal });
    this.attempts.set(a.id, { ...a }); return { ...a };
  }
  async findAttempt(i: AttemptIdentity) {
    const a = this.attempts.get(i.id);
    return a && a.tenantId === i.tenantId && a.reportId === i.reportId && a.principal === i.principal && a.revision === i.revision ? { ...a } : undefined;
  }
  async beginAttempt(i: AttemptIdentity, writer: string) {
    const a = await this.findAttempt(i); const r = this.rows.get(i.reportId);
    if (!a || a.state !== 'declared' || a.writer || Date.parse(a.leaseUntil) <= Date.now() || !r || r.deletedAt || r.uploadRevision !== a.revision || r.uploadedAt) return false;
    const actual = this.attempts.get(i.id)!;
    if (actual.state !== 'declared') return false;
    this.attempts.set(a.id, { ...a, state: 'intaking', leaseUntil:new Date(Date.now()+3600000).toISOString(), writer }); return true;
  }
  async validateAttempt(i: AttemptIdentity, writer: string) { const a=await this.findAttempt(i); const current=this.attempts.get(i.id); if (!a || !current || current.writer!==writer || current.state!=='intaking'||Date.parse(current.leaseUntil)<=Date.now()) return false; this.attempts.set(a.id,{...current,validated:true,leaseUntil:new Date(Date.now()+3600000).toISOString()});return true; }
  async settleAttempt(i: AttemptIdentity, writer: string, state: UploadState, version?: string) {
    const a = await this.findAttempt(i);const current=this.attempts.get(i.id); if (!a || !current || current.writer !== writer || !['intaking','cancelling'].includes(current.state)) return false;
    this.attempts.set(a.id, { ...current, state: current.state === 'cancelling' ? (state === 'unresolved' ? 'unresolved' : 'cancelled') : state, writer: null, version: version ?? current.version }); return true;
  }

  async recoverAttempt(i: AttemptIdentity, version: string) { const a=await this.findAttempt(i);const current=this.attempts.get(i.id);if(!a||!current||current.state!=='unresolved'||!a.validated||a.writer||(a.version&&a.version!==version))return false;this.attempts.set(a.id,{...current,state:current.cancelRequested?'cancelled':'stored',version});return true; }
  async cancelAttempt(i: AttemptIdentity) {
    const a = await this.findAttempt(i); if (!a || ['committed','cleanup','cleaned'].includes(a.state)) return a;
    const actual = this.attempts.get(i.id)!;
    if (['committed','cleanup','cleaned'].includes(actual.state)) return { ...actual };
    this.attempts.set(a.id, { ...actual, cancelRequested: true, state: actual.writer ? 'cancelling' : actual.state === 'unresolved' ? 'unresolved' : 'cancelled' }); return { ...this.attempts.get(a.id)! };
  }
  async commitAttempt(i: AttemptIdentity) {
    const a = await this.findAttempt(i); const r = this.rows.get(i.reportId);
    if (!a || !r || r.deletedAt || r.tenantId !== i.tenantId) return false;
    if (a.state === 'committed') return r.storageKey === a.key && r.objectVersion === a.version && r.sha256 === a.sha256;
    if (a.cancelRequested || a.state !== 'stored' || !a.validated || !a.version || a.writer || Date.parse(a.leaseUntil) <= Date.now() || r.uploadedAt || r.uploadRevision !== a.revision || r.storageKey !== a.key || r.sha256 !== a.sha256 || r.contentType !== a.contentType || r.type !== a.type || r.patientId !== a.patientId || r.sizeBytes !== a.sizeBytes) return false;
    // No await between final comparison and both writes: memory mirrors one PostgreSQL transaction.
    const current = this.attempts.get(a.id)!; if (current.state !== 'stored') return false;
    const now = new Date().toISOString();
    this.rows.set(r.id, { ...r, uploadedAt: now, updatedAt: now, uploadedBy: a.principal, objectVersion: a.version });
    this.attempts.set(a.id, { ...a, state: 'committed' }); return true;
  }
  async runStatus(tenantId:string,runId:string){const pending=[...this.attempts.values()].filter(a=>a.tenantId===tenantId&&a.runId===runId&&!['committed','cleaned'].includes(a.state));return {pendingBytes:pending.reduce((n,a)=>n+a.sizeBytes,0),pendingCount:pending.length,...(this.reconciliation.get(JSON.stringify([tenantId,runId]))??{lastReconciledAt:null,cleanupStalled:false})};}
  async recordReconciliation(tenantId:string,runId:string,success:boolean){const key=JSON.stringify([tenantId,runId]);this.reconciliation.set(key,{lastReconciledAt:success?new Date().toISOString():this.reconciliation.get(key)?.lastReconciledAt??null,cleanupStalled:!success});}
  async runAttempts(tenantId: string, runId: string) { return [...this.attempts.values()].filter(a=>a.tenantId===tenantId && a.runId===runId).map(a=>({...a})); }
  async reportAttempts(tenantId: string, reportId: string) { return [...this.attempts.values()].filter(a=>a.tenantId===tenantId && a.reportId===reportId).map(a=>({...a})); }
  async hasAttempts(tenantId: string, reportId: string) { return [...this.attempts.values()].some(a=>a.tenantId===tenantId && a.reportId===reportId); }
  async sweepCandidates(tenantId: string, runId: string) { return [...this.attempts.values()].filter(a => a.tenantId === tenantId && a.runId === runId && !['committed','cleaned'].includes(a.state)).map(a => ({...a})); }
  async referenced(tenantId: string, key: string, version: string) { return [...this.rows.values()].some(r => r.tenantId === tenantId && r.storageKey === key && !!r.uploadedAt && (!r.objectVersion || r.objectVersion === version)); }
  async claimCleanup(tenantId: string, id: string, graceSeconds: number) {
    const a = this.attempts.get(id); if (!a || a.tenantId !== tenantId || a.state === 'committed' || a.state === 'cleaned') return false;
    if (a.state !== 'cleanup' && a.state !== 'cancelled' && Date.parse(a.leaseUntil) + graceSeconds*1000 > Date.now()) return false;
    if (a.writer && Date.parse(a.leaseUntil) + graceSeconds*1000 > Date.now()) return false;
    if ([...this.rows.values()].some(r => r.tenantId === tenantId && r.storageKey === a.key && r.uploadedAt)) return false;
    this.attempts.set(id, { ...a, state: 'cleanup', writer: null }); return true;
  }
  async finishCleanup(tenantId: string, id: string) { const a = this.attempts.get(id); if (a && a.tenantId === tenantId && a.state === 'cleanup') this.attempts.set(id, { ...a, state: 'cleaned' }); }
  async delete(tenantId: string, id: string) {
    const row = this.rows.get(id);
    if (!row || row.tenantId !== tenantId) return false;
    this.rows.set(id, { ...row, deletedAt: new Date().toISOString() }); return true;
  }
}
