import { Module } from '@nestjs/common';
import { PatientMedicationsModule } from '../patient-medications/patient-medications.module';
import { GenomicProfileController } from './genomic-profile.controller';
import { GenomicProfileService } from './genomic-profile.service';

/** Spec 044 slice A. The evaluations service and the read gate come from the global LabReportsModule; the medications service from its module. */
@Module({ imports: [PatientMedicationsModule], controllers: [GenomicProfileController], providers: [GenomicProfileService] })
export class GenomicProfileModule {}
