import { type AcceptanceDto, acceptanceDtoSchema, type CaptureDto, captureDtoSchema } from '@telesphoros/shared-types';
import type { Projected } from '../storage/ledger-records';

/**
 * Stored record -> public shape. These are allow-lists: a field that is not named here (the storage key, the identity of the person who
 * created the record, the ledger event id) cannot reach a response, and the strict schemas fail loudly if the stored shape ever changes.
 */
export function toAcceptanceDto(record: Projected): AcceptanceDto {
  return acceptanceDtoSchema.parse({
    id: record.id,
    captureId: record.captureId,
    decision: record.decision,
    textSha256: record.textSha256,
    popplerVersion: record.popplerVersion,
    note: record.note ?? null,
    createdAt: record.createdAt,
  });
}

export function toCaptureDto(record: Projected, latestDecision: Projected | undefined): CaptureDto {
  return captureDtoSchema.parse({
    id: record.id,
    reportId: record.reportId,
    pdfSha256: record.pdfSha256,
    textSha256: record.textSha256,
    textScalars: record.textScalars,
    popplerVersion: record.popplerVersion,
    runner: record.runner,
    createdAt: record.createdAt,
    latestDecision: latestDecision ? toAcceptanceDto(latestDecision) : null,
  });
}
