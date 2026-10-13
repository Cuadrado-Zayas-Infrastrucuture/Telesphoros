import { Module } from '@nestjs/common';
import { PatientIdentifiersController, ReportPatientLinkController } from './patient-identity.controller';
import { PatientIdentityService } from './patient-identity.service';
import { PatientLinkService } from './patient-link.service';

/** Patient identifiers (always on) and the report-to-patient link (a lab-report pipeline route, behind its switch). */
@Module({
  controllers: [PatientIdentifiersController, ReportPatientLinkController],
  providers: [PatientIdentityService, PatientLinkService],
})
export class PatientIdentityModule {}
