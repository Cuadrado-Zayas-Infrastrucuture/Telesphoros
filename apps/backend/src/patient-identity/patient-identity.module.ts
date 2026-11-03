import { StructuredRecordsService } from './structured-records.service';
import { StructuredPreviewController, StructuredPreviewGuard } from './structured-preview.controller';
import { StructuredPreviewService } from './structured-preview.service';
import { Module } from '@nestjs/common';
import { PatientIdentifiersController, PatientLinkQuarantineController, ReportPatientLinkController } from './patient-identity.controller';
import { PatientIdentityService } from './patient-identity.service';
import { PatientLinkService } from './patient-link.service';

/** Patient identifiers (always on) and the report-to-patient link (a lab-report pipeline route, behind its switch). */
@Module({
  controllers: [StructuredPreviewController, PatientIdentifiersController, ReportPatientLinkController, PatientLinkQuarantineController],
  providers: [StructuredRecordsService, StructuredPreviewService, StructuredPreviewGuard, PatientIdentityService, PatientLinkService],
})
export class PatientIdentityModule {}
