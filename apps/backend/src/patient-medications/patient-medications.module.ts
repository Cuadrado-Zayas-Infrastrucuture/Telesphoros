import { Module } from '@nestjs/common';
import { PatientMedicationsController } from './patient-medications.controller';
import { bundledMedicationList, MEDICATION_DRUG_LIST, PatientMedicationsService } from './patient-medications.service';
@Module({ controllers: [PatientMedicationsController], providers: [PatientMedicationsService, { provide: MEDICATION_DRUG_LIST, useFactory: bundledMedicationList }] })
export class PatientMedicationsModule {}
