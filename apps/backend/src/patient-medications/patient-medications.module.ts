import { Module } from '@nestjs/common';
import { PatientMedicationsController } from './patient-medications.controller';
import { bundledMedicationList, MEDICATION_DRUG_LIST, PatientMedicationsService } from './patient-medications.service';
// The service is exported for the genomic profile (spec 044) only; the boundary test keeps every other reader out (MD-6, D8).
@Module({
  controllers: [PatientMedicationsController],
  providers: [PatientMedicationsService, { provide: MEDICATION_DRUG_LIST, useFactory: bundledMedicationList }],
  exports: [PatientMedicationsService],
})
export class PatientMedicationsModule {}
