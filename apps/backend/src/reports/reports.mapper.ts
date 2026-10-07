import { type ReportDto, reportDtoSchema } from '@telesphoros/shared-types';
import type { ReportRecord } from '../storage/records';

export function toReportDto(record: ReportRecord): ReportDto {
  return reportDtoSchema.parse({
    id: record.id,
    patientId: record.patientId,
    type: record.type,
    filename: record.filename,
    sizeBytes: record.sizeBytes,
    status: record.status,
    fileUploaded: Boolean(record.uploadedAt),
    contentType: record.contentType ?? null,
    sha256: record.sha256 ?? null,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  });
}
