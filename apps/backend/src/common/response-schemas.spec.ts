import {
  patientDemographicsDtoSchema,
  patientLinkDecisionDtoSchema,
  patientMedicationDtoSchema,
  patientMedicationsDtoSchema,
  structuredPreviewSchema,
  structuredRecordStateSchema,
} from '@telesphoros/shared-types';
import type { Principal } from '../auth/principal';
import { PatientDemographicsController } from '../patient-demographics/patient-demographics.controller';
import type { PatientDemographicsService } from '../patient-demographics/patient-demographics.service';
import { ReportPatientLinkController } from '../patient-identity/patient-identity.controller';
import type { PatientLinkService } from '../patient-identity/patient-link.service';
import { StructuredPreviewController } from '../patient-identity/structured-preview.controller';
import type { StructuredPreviewService } from '../patient-identity/structured-preview.service';
import type { StructuredRecordsService } from '../patient-identity/structured-records.service';
import { IntakeService } from '../reports/intake/intake.service';
import { PatientMedicationsController } from '../patient-medications/patient-medications.controller';
import type { PatientMedicationsService } from '../patient-medications/patient-medications.service';

// The responses these controllers send are built by hand in their services. Each one must pass through its strict schema at the controller,
// so a field a service adds by mistake (a tenant id, a storage key, ciphertext) is refused instead of sent. Each case stubs the service with a
// sentinel and checks that the named schema's parse received it and that its result, not the sentinel, is what the controller returns.
// The schemas' own strictness is tested in shared-types (report-upload.test.ts, and the existing tests of the others).

const principal: Principal = { sub: 'syn-clinician', tenantId: 'syn-tenant', roles: ['clinician', 'reviewer'] };
const ID = '00000000-0000-4000-8000-000000000000';
const res = { status: jest.fn() } as never;
const parsed = (schema: { parse: (v: unknown) => unknown }) => {
  const out = { checked: true };
  return { spy: jest.spyOn(schema, 'parse').mockReturnValue(out as never), out };
};
afterEach(() => jest.restoreAllMocks());

type Case = [string, { parse: (v: unknown) => unknown }, (sentinel: unknown) => Promise<unknown>];
const sentinel = { stub: 'service result', tenantId: 'must not be sent unchecked' };

const cases: Case[] = [
  [
    'GET patients/:id/medications',
    patientMedicationsDtoSchema,
    (s) => new PatientMedicationsController({ read: async () => s } as unknown as PatientMedicationsService).get(principal, { id: ID }, {} as never),
  ],
  [
    'POST patients/:id/medications',
    patientMedicationDtoSchema,
    (s) => new PatientMedicationsController({ record: async () => s } as unknown as PatientMedicationsService).record(principal, { id: ID }, {} as never),
  ],
  [
    'GET patients/:id/demographics',
    patientDemographicsDtoSchema,
    (s) => new PatientDemographicsController({ read: async () => s } as unknown as PatientDemographicsService).get(principal, { id: ID }, {} as never),
  ],
  [
    'POST patients/:id/demographics',
    patientDemographicsDtoSchema,
    (s) => new PatientDemographicsController({ record: async () => s } as unknown as PatientDemographicsService).record(principal, { id: ID }, {} as never),
  ],
  [
    'GET reports/:id/structured-preview',
    structuredPreviewSchema,
    (s) => new StructuredPreviewController({ get: async () => s } as unknown as StructuredPreviewService, {} as StructuredRecordsService).get(principal, { id: ID }),
  ],
  [
    'GET reports/:id/structured-preview/record',
    structuredRecordStateSchema,
    (s) => new StructuredPreviewController({} as StructuredPreviewService, { get: async () => s } as unknown as StructuredRecordsService).record(principal, { id: ID }),
  ],
  [
    'POST reports/:id/structured-preview/record',
    structuredRecordStateSchema,
    (s) =>
      new StructuredPreviewController({} as StructuredPreviewService, { save: async () => ({ created: true, state: s }) } as unknown as StructuredRecordsService).saveRecord(
        principal,
        { id: ID },
        {} as never,
        res,
      ),
  ],
  [
    'POST reports/:id/structured-preview/review',
    structuredRecordStateSchema,
    (s) =>
      new StructuredPreviewController({} as StructuredPreviewService, { review: async () => ({ created: true, state: s }) } as unknown as StructuredRecordsService).reviewFinding(
        principal,
        { id: ID },
        {} as never,
        res,
      ),
  ],
  [
    'POST reports/:id/structured-preview/source-resolution',
    structuredRecordStateSchema,
    (s) =>
      new StructuredPreviewController({} as StructuredPreviewService, { resolve: async () => ({ created: true, state: s }) } as unknown as StructuredRecordsService).resolveSources(
        principal,
        { id: ID },
        {} as never,
        res,
      ),
  ],
  [
    'POST reports/:id/structured-preview/patient-link',
    patientLinkDecisionDtoSchema,
    (s) =>
      new StructuredPreviewController({ decide: async () => ({ created: true, decision: s }) } as unknown as StructuredPreviewService, {} as StructuredRecordsService).decide(
        principal,
        { id: ID },
        {} as never,
        res,
      ),
  ],
  [
    'POST reports/:id/patient-link/decisions',
    patientLinkDecisionDtoSchema,
    (s) =>
      new ReportPatientLinkController({ decide: async () => ({ created: true, decision: s }) } as unknown as PatientLinkService).decide(principal, { id: ID }, {} as never, res),
  ],
];

describe('hand-built responses pass through their strict schema at the controller', () => {
  it.each(cases)('%s', async (_route, schema, call) => {
    const { spy, out } = parsed(schema);
    await expect(call(sentinel)).resolves.toBe(out);
    expect(spy).toHaveBeenCalledWith(sentinel);
  });

  it('a real schema refuses the sentinel, so a mistake would answer 500 rather than send it (control)', async () => {
    await expect(cases[0]![2](sentinel)).rejects.toThrow();
  });
});

describe('the upload intake responses are built from an explicit field list and checked', () => {
  const REVISION = '11111111-1111-4111-8111-111111111111';
  const run = { pendingBytes: 0, pendingCount: 0, lastReconciledAt: null, cleanupStalled: false };
  // The stored attempt carries what must never be sent: its storage key, tenant, principal and digest.
  const attempt = {
    id: ID,
    revision: REVISION,
    state: 'cancelling',
    leaseUntil: '2026-11-11T12:00:00.000Z',
    validated: false,
    key: 'reports/t/r/intake/a',
    tenantId: 'syn-tenant',
    principal: 'syn-clinician',
    sha256: 'a'.repeat(64),
  };
  const intake = (reports: object) => new IntakeService(reports as never, {} as never, {} as never, {} as never, {} as never);
  const report = { id: ID, uploadRevision: REVISION, uploadedAt: null, storageKey: 'reports/t/r/file' };

  it('upload-state sends the revision, whether a file is stored and the run counts, and nothing else', async () => {
    const state = await intake({ findById: async () => report, runStatus: async () => run }).state(principal, ID);
    expect(state).toEqual({ revision: REVISION, fileUploaded: false, run });
  });

  it('upload-state refuses a run status that carries anything more (a mistake answers 500 instead of sending it)', async () => {
    await expect(intake({ findById: async () => report, runStatus: async () => ({ ...run, prefix: 'reports/t/' }) }).state(principal, ID)).rejects.toThrow();
  });

  it('an attempt is sent as its id, revision, state and expiry: never its storage key, tenant, principal or digest', async () => {
    const sent = await intake({ cancelAttempt: async () => attempt }).cancel(principal, ID, ID, REVISION);
    expect(sent).toEqual({ attemptId: ID, revision: REVISION, state: 'cancelling', expiresAt: attempt.leaseUntil });
  });

  it('an attempt in a state the browser does not know is refused, not sent (control for the schema at the boundary)', async () => {
    await expect(intake({ cancelAttempt: async () => ({ ...attempt, state: 'internal-only' }) }).cancel(principal, ID, ID, REVISION)).rejects.toThrow();
  });
});
