import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import { Inject, Injectable } from '@nestjs/common';
import { REPORT_CONTENT_TYPES } from '@telesphoros/shared-types';
import type { Principal } from '../../auth/principal';
import { AppException } from '../../common/app-exception';
import { ENV, type Env } from '../../config/env';
import { ObjectStorage } from '../../object-storage/object-storage';
import { ReportsRepository } from '../../storage/reports.repository';
import type { AttemptIdentity, UploadAttempt } from '../../storage/upload-attempt';
import { type AttemptDeclaration, revisionHeaderSchema } from './contracts';
import { assertLocalStorage } from './local-policy';
import { StagingDisposalError, IntakeRejectedError, stage, type StagedFile } from './stage';
import { InvalidStructureError } from './structural-validator';
const conflict = () => AppException.conflictBecause('upload-attempt-conflict', 'The upload attempt is stale, cancelled, incomplete or unavailable.');
const publicAttempt = (a: UploadAttempt) => ({ attemptId: a.id, revision: a.revision, state: a.state, expiresAt: a.leaseUntil });
@Injectable()
export class IntakeService {
    private readonly active = new Map<string, AbortController>();
    constructor(private readonly reports: ReportsRepository, private readonly storage: ObjectStorage, 
    @Inject(ENV)
    private readonly env: Env) { }
    private allowed(p: Principal) { if (!p.roles.some(r => r === 'clinician' || r === 'admin'))
        throw AppException.forbidden(); assertLocalStorage(this.env); }
    private identity(p: Principal, reportId: string, id: string, revision: unknown): AttemptIdentity {
        const parsed = revisionHeaderSchema.safeParse(revision);
        if (!parsed.success)
            throw AppException.validation([{ field: 'X-Upload-Revision', message: 'A valid upload revision is required.' }]);
        return { tenantId: p.tenantId, reportId, id, principal: p.sub, revision: parsed.data };
    }
    async state(p: Principal, id: string) {
        this.allowed(p);
        const r = await this.reports.findById(p.tenantId, id);
        if (!r)
            throw AppException.notFound();
        return { revision: r.uploadRevision, fileUploaded: !!r.uploadedAt, run: await this.reports.runStatus(p.tenantId, this.env.LOCAL_STORAGE_RUN_ID!) };
    }
    async declare(p: Principal, id: string, input: AttemptDeclaration) {
        this.allowed(p);
        const r = await this.reports.findById(p.tenantId, id);
        if (!r)
            throw AppException.notFound();
        if (!REPORT_CONTENT_TYPES[r.type].includes(input.contentType))
            throw AppException.validation([{ field: 'contentType', message: 'The declared MIME type must match the report.' }]);
        const inventory = await this.storage.uploadVersions(`local-storage/${this.env.LOCAL_STORAGE_RUN_ID}/`, AbortSignal.timeout(30000));
        const multipart = await this.storage.uploadMultipart(`local-storage/${this.env.LOCAL_STORAGE_RUN_ID}/`, AbortSignal.timeout(30000));
        if (multipart.length)
            throw AppException.unavailable('Multipart inventory requires reconciliation before new writes.');
        const known = await this.reports.runAttempts(p.tenantId, this.env.LOCAL_STORAGE_RUN_ID!);
        if (inventory.some(v => !known.some(a => a.key === v.key)) || new Set(inventory.map(v => v.key)).size !== inventory.length)
            throw AppException.unavailable('Upload inventory requires reconciliation before new writes.');
        const attemptId = randomUUID();
        const now = new Date();
        const a: UploadAttempt = { id: attemptId, requestId: input.requestId, runId: this.env.LOCAL_STORAGE_RUN_ID!, tenantId: p.tenantId, reportId: id, patientId: r.patientId, principal: p.sub,
            revision: input.revision, declarationRevision: input.revision, type: r.type, sizeBytes: r.sizeBytes, contentType: input.contentType, sha256: input.sha256, key: `local-storage/${this.env.LOCAL_STORAGE_RUN_ID}/${attemptId}`,
            state: 'declared', validated: false, cancelRequested: false, version: null, writer: null, leaseUntil: new Date(now.getTime() + 3600000).toISOString(), createdAt: now.toISOString() };
        const declared = await this.reports.declareAttempt(a, input.revision);
        if (!declared)
            throw conflict();
        if (Date.parse(declared.leaseUntil) <= Date.now() && declared.state !== 'committed')
            throw conflict();
        return publicAttempt(declared);
    }
    async cancel(p: Principal, reportId: string, id: string, revision: unknown) {
        this.allowed(p);
        const i = this.identity(p, reportId, id, revision);
        const a = await this.reports.cancelAttempt(i);
        if (!a)
            throw AppException.notFound();
        this.active.get(a.id)?.abort();
        if (a.state === 'cancelled' && !a.validated && !this.active.has(a.id)) {
            await this.releaseEmpty(a);
            return publicAttempt((await this.reports.findAttempt(i))!);
        }
        return publicAttempt(a);
    }
    async resume(p: Principal, reportId: string, id: string, revision: unknown) {
        this.allowed(p);
        const i = this.identity(p, reportId, id, revision);
        let a = await this.reports.findAttempt(i);
        if (!a)
            throw AppException.notFound();
        if (a.state === 'committed')
            return publicAttempt(a);
        if (!['stored', 'unresolved'].includes(a.state) || !a.validated || a.writer)
            throw conflict();
        const versions = await this.storage.uploadVersions(a.key, AbortSignal.timeout(30000));
        if (versions.length !== 1 || versions[0].key !== a.key || versions[0].deleted)
            throw conflict();
        const stored = await this.storage.inspect(a.key, { version: versions[0].version });
        this.verify(a, stored);
        if (a.state === 'unresolved') {
            if (!await this.reports.recoverAttempt(i, stored!.version!))
                throw conflict();
            a = (await this.reports.findAttempt(i))!;
        }
        if (a.state !== 'stored' || !await this.reports.commitAttempt(i))
            throw conflict();
        return publicAttempt((await this.reports.findAttempt(i))!);
    }
    private verify(a: UploadAttempt, o: Awaited<ReturnType<ObjectStorage['inspect']>>) {
        if (!o || !o.version || o.version === 'null' || o.sizeBytes !== a.sizeBytes || o.sha256 !== a.sha256 || o.contentType !== a.contentType || (a.version && o.version !== a.version))
            throw conflict();
    }
    async intake(p: Principal, reportId: string, id: string, revision: unknown, source: Readable, headers: Record<string, unknown>) {
        this.allowed(p);
        const i = this.identity(p, reportId, id, revision);
        let a = await this.reports.findAttempt(i);
        if (!a)
            throw AppException.notFound();
        if (headers['content-type'] !== a.contentType || (headers['content-encoding'] !== undefined && headers['content-encoding'] !== 'identity'))
            throw AppException.validation([{ field: 'Content-Type', message: 'Send raw bytes with the declared MIME type and no compression.' }]);
        if (a.state !== 'declared')
            throw conflict();
        if (this.active.has(a.id))
            throw conflict();
        if (this.active.size >= 2)
            throw AppException.unavailable('File intake is busy. Try again shortly.');
        const control = new AbortController();
        const writer = randomUUID();
        this.active.set(a.id, control);
        let staged: StagedFile | undefined;
        let attemptedWrite = false;
        let safelyQuiesced = false;
        try {
            if (!await this.reports.beginAttempt(i, writer))
                throw conflict();
            staged = await stage(source, a.type, a.sizeBytes, a.sha256, control.signal, a.runId);
            if (!await this.reports.validateAttempt(i, writer))
                throw conflict();
            if (control.signal.aborted)
                throw new IntakeRejectedError('cancelled');
            if (!await this.storage.versioningEnabled())
                throw conflict();
            attemptedWrite = true;
            const stream = createReadStream(staged.path, { highWaterMark: 65536 });
            let version: string | undefined;
            try {
                ({ version } = await this.storage.putStream(a.key, stream, a.contentType, staged.bytes, AbortSignal.any([control.signal, AbortSignal.timeout(30000)]), { 'upload-run': a.runId, 'upload-attempt': a.id }));
            }
            finally {
                stream.destroy();
            }
            if (!version || version === 'null')
                throw conflict();
            a = { ...a, version };
            const stored = await this.storage.inspect(a.key, { version, signal: AbortSignal.any([control.signal, AbortSignal.timeout(30000)]) });
            this.verify(a, stored);
            if (!await this.reports.settleAttempt(i, writer, 'stored', version))
                throw conflict();
            if (!await this.reports.commitAttempt(i)) {
                await this.reports.cancelAttempt(i);
                throw conflict();
            }
            return publicAttempt((await this.reports.findAttempt(i))!);
        }
        catch (error) {
            // A lost reply is unknown, not a rollback certificate. Reconcile on retry/owned sweep; never blindly delete.
            try {
                if (!attemptedWrite)
                    await this.reports.cancelAttempt(i);
                safelyQuiesced = await this.reports.settleAttempt(i, writer, attemptedWrite && !(control.signal.aborted && a.version) ? 'unresolved' : 'cancelled', a.version ?? undefined) && !(error instanceof StagingDisposalError);
            }
            catch { /* durable lease/journal survives database outage */ }
            if (control.signal.aborted && attemptedWrite)
                throw conflict();
            if (error instanceof InvalidStructureError || error instanceof IntakeRejectedError)
                throw AppException.validation([{ field: 'file', message: 'The file failed bounded intake validation.' }]);
            throw error;
        }
        finally {
            this.active.delete(a.id);
            if (staged)
                await staged.dispose();
            // Release only after owned staging disposal and affirmative empty inventory; failed reads retain the reservation.
            if (!attemptedWrite && safelyQuiesced)
                await this.releaseEmpty(a);
        }
    }
    private async releaseEmpty(a: UploadAttempt) { try {
        const versions = await this.storage.uploadVersions(a.key, AbortSignal.timeout(30000));
        const multipart = await this.storage.uploadMultipart(a.key, AbortSignal.timeout(30000));
        if (!versions.some(v => v.key === a.key) && !multipart.some(v => v.key === a.key) && await this.reports.claimCleanup(a.tenantId, a.id, this.env.LOCAL_UPLOAD_CLEANUP_GRACE_SECONDS))
            await this.reports.finishCleanup(a.tenantId, a.id);
    }
    catch { /* Retain quota on any unconfirmed inventory/DB result. */ } }
}
