import { createHash } from 'node:crypto';
import { Injectable, Logger, Optional } from '@nestjs/common';
import { type AcceptanceDto, type CaptureDto, type DecisionCreate, type FileLinkDto, MAX_REPORT_BYTES } from '@telesphoros/shared-types';
import type { Principal } from '../auth/principal';
import { AppException } from '../common/app-exception';
import { SourceChangedError } from '../ledger/ledger-types';
import { ObjectStorage, ObjectTooLargeError } from '../object-storage/object-storage';
import { CaptureDecisionRequestReusedError, LedgerRecordsRepository } from '../storage/ledger-records.repository';
import type { Projected } from '../storage/ledger-records';
import type { ReportRecord } from '../storage/records';
import { ReportsRepository } from '../storage/reports.repository';
import { toAcceptanceDto, toCaptureDto } from './lab-report.mapper';
import { textObjectKey } from './object-keys';
import { PipelineSwitch } from './pipeline-switch';
import { RunnerMisconfiguredError, TextCaptureRunner, UnsupportedSourceError } from './runner/text-capture-runner';

/** The database allows up to this many Unicode scalars of captured text. */
export const MAX_TEXT_SCALARS = 100_000;

/** The roles that may open a stored file (the PDF or its text). A `reader` may not: a PDF is the most sensitive artifact here. */
export { FILE_LINK_ROLES } from '../auth/file-access';
import { FILE_LINK_ROLES } from '../auth/file-access';

export interface CaptureOutcome {
  capture: CaptureDto;
  created: boolean;
}

@Injectable()
export class CapturesService {
  private readonly logger = new Logger('LabReportCaptures');

  // The pipeline's collaborators exist only when it is switched on (and, for the ledger, only with PostgreSQL). Every route is behind the
  // gate, which answers 503 before any of them is touched; `need` is the second line of defence if one is ever reached without them.
  constructor(
    private readonly reports: ReportsRepository,
    private readonly storage: ObjectStorage,
    private readonly pipeline: PipelineSwitch,
    @Optional() private readonly ledger?: LedgerRecordsRepository,
    @Optional() private readonly runner?: TextCaptureRunner,
  ) {}

  private need<T>(dependency: T | undefined): T {
    if (dependency === undefined || dependency === null) throw AppException.pipelineMisconfigured();
    return dependency;
  }

  /**
   * The capture protocol (plan 12.3). Read the report's bindings; fetch the PINNED version OUTSIDE any transaction and hash what came
   * back; run the runner; write the text; then, in ONE transaction, lock the report row, re-read the bindings and compare, and only
   * then insert. A report that changed in between is `source-changed`, never a capture of something else.
   */
  async capture(principal: Principal, reportId: string): Promise<CaptureOutcome> {
    const ledger = this.need(this.ledger);
    const runner = this.need(this.runner);
    const report = await this.requireUploadedLabPdf(principal, reportId);

    let fetched;
    try {
      fetched = await this.storage.getObject(report.storageKey!, { version: report.objectVersion!, maxBytes: MAX_REPORT_BYTES });
    } catch (error) {
      if (error instanceof ObjectTooLargeError) throw AppException.conflictBecause('source-changed', 'The stored file is not the one that was verified.');
      throw error;
    }
    if (!fetched) throw AppException.conflictBecause('source-missing', 'The stored version of this file is no longer available.');
    if (fetched.sha256 !== report.sha256 || fetched.version !== report.objectVersion) {
      throw AppException.conflictBecause('source-changed', 'The stored file is not the one that was verified.');
    }

    let read;
    try {
      read = await runner.capture(fetched.bytes);
    } catch (error) {
      if (error instanceof UnsupportedSourceError) throw AppException.unsupportedSource();
      if (error instanceof RunnerMisconfiguredError) {
        this.logger.error({ event: 'text-runner-misconfigured', code: error.code }, 'The text runner is not installed correctly');
        throw AppException.pipelineMisconfigured();
      }
      throw error;
    }

    const text = Buffer.from(read.text, 'utf8');
    const textSha256 = createHash('sha256').update(text).digest('hex');
    const textScalars = [...read.text].length;
    if (textScalars > MAX_TEXT_SCALARS) throw AppException.unsupportedSource();

    const identity = { reportId: report.id, textSha256, popplerVersion: read.popplerVersion };
    const already = await ledger.findCaptureByIdentity(principal.tenantId, identity);
    if (already) return { capture: await this.present(principal, already), created: false };

    const textStorageKey = textObjectKey(principal.tenantId, report.id, textSha256, read.popplerVersion);
    await this.storage.putObject(textStorageKey, text, 'text/plain; charset=utf-8');

    try {
      const stored = await ledger.insertCapture(principal.tenantId, principal.sub, {
        reportId: report.id,
        expectedReport: { patientId: report.patientId, sha256: report.sha256!, objectVersion: report.objectVersion!, storageKey: report.storageKey! },
        pdfSha256: report.sha256!,
        textStorageKey,
        textSha256,
        textScalars,
        popplerVersion: read.popplerVersion,
        runner: runner.name,
      });
      return { capture: await this.present(principal, stored.record), created: stored.created };
    } catch (error) {
      if (error instanceof SourceChangedError) throw AppException.conflictBecause('source-changed', 'The report changed while it was being captured. Nothing was saved; capture it again.');
      throw error;
    }
  }

  async get(principal: Principal, captureId: string): Promise<CaptureDto> {
    return this.present(principal, await this.requireCapture(principal, captureId));
  }

  /** A link to the captured TEXT, for the roles that may open files. The text is re-read and re-hashed first, so the link names a version whose bytes were checked. */
  async textLink(principal: Principal, captureId: string): Promise<FileLinkDto> {
    this.requireFileRole(principal);
    const capture = await this.requireCapture(principal, captureId);
    const key = capture.textStorageKey as string;
    const inspected = await this.storage.inspect(key);
    if (!inspected) throw AppException.conflictBecause('source-missing', 'The captured text is no longer available.');
    if (inspected.sha256 !== capture.textSha256) throw AppException.conflictBecause('text-hash-mismatch', 'The stored text is not the text that was captured.');
    if (!inspected.version) throw AppException.conflictBecause('source-unpinned', 'The stored text has no version, so it cannot be linked as evidence.');
    return this.link(await this.storage.createDownloadUrl(key, inspected.version, this.pipeline.downloadUrlTtlSeconds));
  }

  /** A link to the PDF, for the roles that may open files: the pinned version only, never "the latest". */
  async pdfLink(principal: Principal, reportId: string): Promise<FileLinkDto> {
    this.requireFileRole(principal);
    const report = await this.requireUploadedLabPdf(principal, reportId);
    return this.link(await this.storage.createDownloadUrl(report.storageKey!, report.objectVersion!, this.pipeline.downloadUrlTtlSeconds));
  }

  /**
   * A person's decision about a capture. The text hash and Poppler version are copied from the capture, never from the request. Whoever
   * ACCEPTS is none of: the report's creator, who asked for the first upload link, who completed the upload, who made the capture
   * (the database repeats the rule; this gives the clear answer first). A rejection is open to any reviewer.
   */
  async decide(principal: Principal, captureId: string, body: DecisionCreate): Promise<AcceptanceDto> {
    const ledger = this.need(this.ledger);
    const capture = await this.requireCapture(principal, captureId);
    const report = await this.reports.findById(principal.tenantId, capture.reportId as string);
    if (!report) throw AppException.notFound('Capture not found.');
    if (body.decision === 'accepted') {
      const excluded = [report.createdBy, report.uploadRequestedBy, report.uploadedBy, capture.createdBy];
      if (excluded.includes(principal.sub)) {
        throw AppException.conflictBecause('self-review', 'You took part in uploading or capturing this report, so you cannot accept it. Another reviewer must.');
      }
    }
    try {
      const stored = await ledger.insertAcceptance(principal.tenantId, principal.sub, {
        captureId,
        decision: body.decision,
        textSha256: capture.textSha256 as string,
        popplerVersion: capture.popplerVersion as string,
        ...(body.note === undefined ? {} : { note: body.note }),
        // The fingerprint of the original request: the capture, the decision and the note. A repeat with the same id and fingerprint returns the decision already stored.
        ...(body.requestId ? { request: { id: body.requestId, hash: createHash('sha256').update(JSON.stringify([captureId.toLowerCase(), body.decision, body.note ?? null])).digest('hex') } } : {}),
      });
      return toAcceptanceDto(stored.record);
    } catch (error) {
      if (error instanceof CaptureDecisionRequestReusedError) throw AppException.conflictBecause('request-id-reused', 'That request id was already used for a different decision.');
      throw error;
    }
  }

  // ---- helpers ---------------------------------------------------------------------------------------------------------------

  private async requireCapture(principal: Principal, id: string): Promise<Projected> {
    const capture = await this.need(this.ledger).findCapture(principal.tenantId, id);
    if (!capture) throw AppException.notFound('Capture not found.');
    return capture;
  }

  /** Same NOT_FOUND for a missing report and another tenant's. 409 reasons for a report that cannot be used. */
  private async requireUploadedLabPdf(principal: Principal, reportId: string): Promise<ReportRecord> {
    const report = await this.reports.findById(principal.tenantId, reportId);
    if (!report) throw AppException.notFound('Report not found.');
    if (report.type !== 'lab-pdf') throw AppException.conflictBecause('wrong-type', 'Only a lab PDF can be captured or linked.');
    if (!report.uploadedAt || !report.objectVersion || !report.storageKey || !report.sha256) {
      throw AppException.conflictBecause('not-uploaded', 'The file for this report has not been uploaded and verified yet.');
    }
    return report;
  }

  private requireFileRole(principal: Principal): void {
    if (!principal.roles.some((role) => (FILE_LINK_ROLES as readonly string[]).includes(role))) throw AppException.forbidden();
  }

  private link(url: string): FileLinkDto {
    return { url, expiresAt: new Date(Date.now() + this.pipeline.downloadUrlTtlSeconds * 1000).toISOString() };
  }

  private async present(principal: Principal, capture: Projected): Promise<CaptureDto> {
    return toCaptureDto(capture, await this.need(this.ledger).latestAcceptance(principal.tenantId, capture.id));
  }
}
