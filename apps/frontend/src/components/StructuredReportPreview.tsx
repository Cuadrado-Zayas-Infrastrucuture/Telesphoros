import type { ReportDto } from '@telesphoros/shared-types';
import { ownedStorageMode, syntheticStagingMode } from '@/lib/storageMode';
import { StructuredPreviewContent } from './StructuredPreviewContent';

/**
 * Two ways in: the owned-local build on a loopback address, or the synthetic staging build. The server repeats each gate (the owned-local checks, or its
 * SYNTHETIC_ASSESSMENT switch). A source preview never enables a clinical assessment.
 */
export function StructuredReportPreview({ report }: { report: ReportDto }) {
  const allowed = (ownedStorageMode() && location.hostname === '127.0.0.1') || syntheticStagingMode();
  if (!allowed || report.type !== 'structured' || !report.fileUploaded) return null;
  return <StructuredPreviewContent key={`${report.id}:${report.sha256}:${report.patientId}:${report.updatedAt}`} reportId={report.id} />;
}
