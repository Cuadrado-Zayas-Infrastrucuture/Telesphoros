import { Module } from '@nestjs/common';
import { GeneModifiersModule } from '../gene-modifiers/gene-modifiers.module';
import { PatientMedicationsModule } from '../patient-medications/patient-medications.module';
import { GenomicProfileController } from './genomic-profile.controller';
import { GenomicProfileService } from './genomic-profile.service';

/**
 * Spec 044 slice A. The evaluations service and the read gate come from the global LabReportsModule; the medications service from its module;
 * the gene modifier lists (spec 045 N2) from theirs.
 */
@Module({ imports: [PatientMedicationsModule, GeneModifiersModule], controllers: [GenomicProfileController], providers: [GenomicProfileService] })
export class GenomicProfileModule {}
