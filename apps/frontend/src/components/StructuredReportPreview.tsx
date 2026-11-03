import type { ReportDto } from '@telesphoros/shared-types';
import { ownedStorageMode } from '@/lib/storageMode';
import { StructuredPreviewContent } from './StructuredPreviewContent';

/** The server repeats the owned-local gate. A source preview never enables a clinical assessment. */
export function StructuredReportPreview({ report }: { report: ReportDto }) {
  if (!ownedStorageMode() || location.hostname !== '127.0.0.1' || report.type !== 'structured' || !report.fileUploaded) return null;
  return <StructuredPreviewContent key={`${report.id}:${report.sha256}:${report.patientId}:${report.updatedAt}`} reportId={report.id} />;
}
