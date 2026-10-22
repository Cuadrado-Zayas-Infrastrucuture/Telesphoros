import { createHash, randomUUID } from 'node:crypto';
import type { DrugResult, GeneStateResult } from '@telesphoros/cpic-schema';
import type { AcceptanceInput, CaptureInput, EvaluationInput } from '../../src/storage/ledger-records';
import { withAdmin } from './database';

/** Synthetic data only. Everything here is invented; no value resembles a real person or report. */
export const sha = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

export interface SeededReport {
  tenantId: string;
  uploader: string;
  patientId: string;
  reportId: string;
  pdfSha256: string;
  objectVersion: string;
  storageKey: string;
}

export interface SeedOptions {
  /** Who created the report record (default `syn-uploader`). */
  uploader?: string;
  /** Who asked for the first upload link, and who completed the upload; each defaults to the creator. */
  requestedBy?: string;
  completedBy?: string;
  label?: string;
}

/** An uploaded lab PDF for a fresh patient, inserted as the owner (this is the state the upload slice will produce). */
export async function seedLabReport(adminUrl: string, tenantId: string, uploaderOrOptions: string | SeedOptions = {}, labelArg?: string): Promise<SeededReport> {
  const options: SeedOptions = typeof uploaderOrOptions === 'string' ? { uploader: uploaderOrOptions, label: labelArg } : uploaderOrOptions;
  const uploader = options.uploader ?? 'syn-uploader';
  const label = options.label ?? `SYN-${randomUUID().slice(0, 8)}`;
  const patientId = randomUUID();
  const reportId = randomUUID();
  const pdfSha256 = sha(`pdf:${reportId}`);
  const objectVersion = `syn-version-${reportId.slice(0, 8)}`;
  await withAdmin(adminUrl, async (c) => {
    // A tenant binds through its capability row, which needs the tenant row (0032 and the foreign key on tenant_capabilities).
    await c.query(`INSERT INTO tenants (id, display_name, created_by, changed_by) VALUES ($1, $1, 'test-helper', 'test-helper') ON CONFLICT (id) DO NOTHING`, [tenantId]);
    await c.query(`INSERT INTO patients (id, tenant_id, created_by, label) VALUES ($1, $2, $3, $4)`, [patientId, tenantId, uploader, label]);
    await c.query(
      `INSERT INTO reports (id, tenant_id, created_by, patient_id, type, original_filename, size_bytes, status, content_type, sha256, storage_key, uploaded_at,
                            object_version, upload_requested_by, uploaded_by)
       VALUES ($1, $2, $3, $4, 'lab-pdf', 'syn.pdf', 1000, 'received', 'application/pdf', $5, $6, now(), $7, $8, $9)`,
      [reportId, tenantId, uploader, patientId, pdfSha256, `k/${reportId}`, objectVersion, options.requestedBy ?? uploader, options.completedBy ?? uploader],
    );
  });
  return { tenantId, uploader, patientId, reportId, pdfSha256, objectVersion, storageKey: `k/${reportId}` };
}

export const captureFor = (r: SeededReport, text = 'synthetic text', over: Partial<CaptureInput> = {}): CaptureInput => ({
  reportId: r.reportId,
  expectedReport: { patientId: r.patientId, sha256: r.pdfSha256, objectVersion: r.objectVersion, storageKey: r.storageKey },
  pdfSha256: r.pdfSha256,
  textStorageKey: `text/${randomUUID()}`,
  textSha256: sha(text),
  textScalars: text.length,
  popplerVersion: '26.03.0',
  runner: 'fake',
  ...over,
});

export const acceptanceFor = (captureId: string, capture: CaptureInput, over: Partial<AcceptanceInput> = {}): AcceptanceInput => ({
  captureId, decision: 'accepted', textSha256: capture.textSha256, popplerVersion: capture.popplerVersion, ...over,
});

export const citation = {
  guidelineId: 'syn-guideline', guidelineVersion: '1', sourceUrl: 'https://example.invalid/syn', locator: { table: 'recommendations', row: 'poor', column: null },
  verification: 'verified',
} as unknown as Extract<DrugResult, { outcome: 'shown' }>['citation'];

export const shownResult: DrugResult = {
  outcome: 'shown', drug: 'syn-drug', genes: ['CYP2C19'],
  geneStates: [{ gene: 'CYP2C19', state: 'canonical', phenotype: 'Poor Metabolizer', reasonCode: null }],
  strength: 'Strong', citation, recommendationText: 'Synthetic wording.', implication: null,
};
export const heldResult: DrugResult = {
  outcome: 'held', drug: 'syn-other', genes: ['CYP2D6'], geneStates: [{ gene: 'CYP2D6', state: 'absent', phenotype: null, reasonCode: 'gene-absent' }],
  reasonCode: 'gene-absent', citation: null,
};
export const noGuidelineResult: DrugResult = { outcome: 'no-guideline', drug: 'syn-none', genes: [], geneStates: [], reasonCode: 'no-guideline-for-drug' };

export const canonicalState: GeneStateResult = { gene: 'CYP2C19', state: 'canonical', phenotype: 'Poor Metabolizer', diplotype: '*2/*2', activityScore: null, reasonCode: null };
export const absentState: GeneStateResult = { gene: 'CYP2D6', state: 'absent', phenotype: null, diplotype: null, activityScore: null, reasonCode: 'gene-absent' };

export function evaluationFor(r: SeededReport, captureId: string, acceptanceId: string, over: Partial<EvaluationInput> = {}): EvaluationInput {
  return {
    patientId: r.patientId, reportId: r.reportId, captureId, captureAcceptanceId: acceptanceId, disposition: 'evaluated', holdCode: null,
    binding: { textSha256: sha('synthetic text'), popplerVersion: '26.03.0', packetHash: sha('packet'), generatorCodeHash: sha('generator'), captureAcceptanceId: acceptanceId },
    knowledgeSetId: sha('knowledge'), engineVersion: 'syn-1',
    geneInputs: [{ gene: 'CYP2C19', state: 'diplotype', diplotype: '*2/*2', callSource: 'lab-report' }], occurrences: [{ gene: 'CYP2C19', offset: 10 }],
    results: [shownResult, heldResult, noGuidelineResult], geneStates: [canonicalState, absentState], ...over,
  };
}
