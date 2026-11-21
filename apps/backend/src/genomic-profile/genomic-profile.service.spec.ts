import type { Principal } from '../auth/principal';
import type { EvaluationsService } from '../lab-reports/evaluations.service';
import type { PatientMedicationsService } from '../patient-medications/patient-medications.service';
import { GENOMIC_PROFILE_MAX_PAGES, GenomicProfileService } from './genomic-profile.service';

// Spec 044 slice A (GP-7): the service reads the medications, then the current evaluations, and nothing else. Each stub holds only the one method
// the service may call, so any other call (a write, a second read) is a TypeError and fails the test.

const principal: Principal = { sub: 'syn-reader', tenantId: 'syn-tenant', roles: ['reader'] };
const PATIENT = '00000000-0000-4000-8000-0000000000b1';

function stubs(order: string[], capped = false) {
  const medications = {
    read: jest.fn(async () => {
      order.push('medications');
      return { items: [] };
    }),
  };
  const evaluations = {
    currentForPatient: jest.fn(async () => {
      order.push('evaluations');
      return { items: [], capped };
    }),
  };
  const service = new GenomicProfileService(evaluations as unknown as EvaluationsService, medications as unknown as PatientMedicationsService);
  return { service, medications, evaluations };
}

describe('GenomicProfileService', () => {
  it('reads the medications first (their read answers 404 for an unknown patient), then the current evaluations, with the page cap', async () => {
    const order: string[] = [];
    const { service, medications, evaluations } = stubs(order);
    await service.read(principal, PATIENT, {});
    expect(order).toEqual(['medications', 'evaluations']);
    expect(medications.read).toHaveBeenCalledWith(principal, PATIENT, {});
    expect(evaluations.currentForPatient).toHaveBeenCalledWith(principal, PATIENT, GENOMIC_PROFILE_MAX_PAGES);
  });

  it('stops at the medications read when it refuses, and reads no evaluation', async () => {
    const order: string[] = [];
    const { service, medications, evaluations } = stubs(order);
    medications.read.mockRejectedValueOnce(new Error('not found'));
    await expect(service.read(principal, PATIENT, {})).rejects.toThrow('not found');
    expect(evaluations.currentForPatient).not.toHaveBeenCalled();
  });

  it('passes the cap and the checked drug through to the profile', async () => {
    const { service } = stubs([], true);
    const profile = await service.read(principal, PATIENT, { rxcui: '111' });
    expect(profile).toMatchObject({ patientId: PATIENT, capped: true, check: { rxcui: '111', word: 'no-guideline-loaded' } });
  });
});
