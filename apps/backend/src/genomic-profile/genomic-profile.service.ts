import { Injectable } from '@nestjs/common';
import type { GenomicProfileDto, GenomicProfileQuery } from '@telesphoros/shared-types';
import type { Principal } from '../auth/principal';
import { EvaluationsService } from '../lab-reports/evaluations.service';
import { PatientMedicationsService } from '../patient-medications/patient-medications.service';
import { buildGenomicProfile } from './genomic-profile.builder';

/** At most this many pages of the evaluation list's largest size are read for one patient; beyond it the profile says it is capped. */
export const GENOMIC_PROFILE_MAX_PAGES = 10;

/**
 * Spec 044 slice A. The only module that reads both a patient's medications and their stored results (the MD-6 boundary, D8): it reads, in
 * this order, the medications (which answers 404 for an unknown or foreign patient) and the current evaluations, then builds the profile.
 * It writes nothing and runs no engine (D6).
 */
@Injectable()
export class GenomicProfileService {
  constructor(
    private readonly evaluations: EvaluationsService,
    private readonly medications: PatientMedicationsService,
  ) {}

  async read(principal: Principal, patientId: string, query: GenomicProfileQuery): Promise<GenomicProfileDto> {
    const { items: medications } = await this.medications.read(principal, patientId, {});
    const { items: evaluations, capped } = await this.evaluations.currentForPatient(principal, patientId, GENOMIC_PROFILE_MAX_PAGES);
    return buildGenomicProfile({ patientId, evaluations, medications, checkRxcui: query.rxcui, capped });
  }
}
