import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { StructuredPreview } from '@telesphoros/shared-types';
import type { LabPipeline, Person } from './lab-pipeline';
import { bearer } from './tokens';

// Builds stored structured revisions through the HTTP API the way a browser and two different people would (spec 032 S2 and S3). Synthetic data only.
const REPO = resolve(__dirname, '../../../..');
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
/** The part of the S1 package this spec changes. */
export interface Package {
  assessment: unknown;
  report: {
    laboratoryId: string;
    status: string;
    limitations: string[];
    assay: { manifest: { laboratoryId: string; targets: unknown[] } };
    findings: Record<string, unknown>[];
  };
}
export const fixture = (): Package => JSON.parse(readFileSync(resolve(REPO, 'data/fixtures/pgx-contracts/resolved/package.json'), 'utf8'));

export type Decision = 'accepted-as-evidence' | 'rejected' | 'held';
export const REASON: Record<Decision, string> = { 'accepted-as-evidence': 'matches-source', rejected: 'does-not-match-source', held: 'needs-clarification' };

export interface Findings {
  a?: string;
  b?: string;
}
/** A package of invented findings. The embedded assessment is left out (the contract allows it), so any finding may be changed freely. */
export function packageBytes(findings: Findings, laboratoryId: string, mutate: (pkg: Package) => void = () => undefined): Buffer {
  const pkg = fixture();
  pkg.assessment = null;
  const report = pkg.report;
  report.laboratoryId = laboratoryId;
  report.assay.manifest.laboratoryId = laboratoryId;
  const a = report.findings[0];
  const call = (value: string) => ({ kind: 'diplotype', originalText: value, value, phase: 'resolved', copyNumber: 2 });
  const list: Record<string, unknown>[] = [];
  if (findings.a !== undefined) list.push({ ...a, reportedCall: call(findings.a) });
  if (findings.b !== undefined) {
    list.push({ ...a, id: 'syn-finding-b', targetId: 'syn-target-b', gene: 'GENEB', reportedCall: call(findings.b) });
    report.assay.manifest.targets.push({ id: 'syn-target-b', gene: 'GENEB', variantClasses: ['sequence'], alleles: ['*1', '*3'], limitations: ['Invented target.'] });
  }
  report.findings = list;
  mutate(pkg);
  return Buffer.from(JSON.stringify(pkg));
}

/** The helpers of one LabPipeline: upload, verify the patient link (a second person), store the revision (the uploader), record each review (the second person). */
export interface Prepared {
  uploader: Person;
  reviewer: Person;
  patientId: string;
  reportId: string;
  laboratoryId: string;
  revisionId: string | null;
  binding: { patientId: string; sha256: string; objectVersion: string; patientLinkDecisionId: string; sourcePatientReference: string };
}
export interface PrepareOptions {
  /** Per finding id; a finding left out is not reviewed. */
  reviews?: Record<string, Decision>;
  /** Same patient (and laboratory) as an earlier upload: a second source for the same laboratory revision. */
  same?: Prepared;
  mutate?: (pkg: Package) => void;
  save?: boolean;
  /** Upload exactly these bytes (a fixture file) instead of building a package from `findings`. */
  bytes?: Buffer;
}

export function structuredFixtures(lab: LabPipeline) {
  /** Upload, verify the patient link (a second person), store the revision (the uploader), and record each review (the second person). */
  async function prepare(findings: Findings, options: PrepareOptions = {}): Promise<Prepared> {
    const laboratoryId = options.bytes ? (JSON.parse(options.bytes.toString('utf8')) as Package).report.laboratoryId : (options.same?.laboratoryId ?? `syn-lab-${randomUUID()}`);
    const content = options.bytes ?? packageBytes(findings, laboratoryId, options.mutate);
    const uploader = options.same?.uploader ?? (await lab.person('uploader', ['clinician', 'reviewer']));
    const reviewer = options.same?.reviewer ?? (await lab.person('reviewer', ['reviewer']));
    const patientId =
      options.same?.patientId ??
      (
        await lab
          .api()
          .post('/api/v1/patients')
          .set(bearer(uploader.token))
          .send({ label: `SYN-${randomUUID().slice(0, 8)}` })
          .expect(201)
      ).body.id;
    const report = (
      await lab.api().post('/api/v1/reports').set(bearer(uploader.token)).send({ patientId, type: 'structured', filename: 'package.json', sizeBytes: content.length }).expect(201)
    ).body;
    const state = (await lab.api().get(`/api/v1/reports/${report.id}/upload-state`).set(bearer(uploader.token)).expect(200)).body;
    const attempt = (
      await lab
        .api()
        .post(`/api/v1/reports/${report.id}/upload-attempts`)
        .set(bearer(uploader.token))
        .send({ requestId: randomUUID(), revision: state.revision, contentType: 'application/json', sha256: sha(content) })
        .expect(201)
    ).body;
    await lab
      .api()
      .put(`/api/v1/reports/${report.id}/upload-attempts/${attempt.attemptId}/bytes`)
      .set(bearer(uploader.token))
      .set('X-Upload-Revision', attempt.revision)
      .set('Content-Type', 'application/json')
      .send(content.toString('utf8'))
      .expect(200);
    const preview = (await lab.api().get(`/api/v1/reports/${report.id}/structured-preview`).set(bearer(uploader.token)).expect(200)).body as StructuredPreview;
    const link = (
      await lab
        .api()
        .post(`/api/v1/reports/${report.id}/structured-preview/patient-link`)
        .set(bearer(reviewer.token))
        .send({
          patientId: preview.patientId,
          sha256: preview.source.sha256,
          objectVersion: preview.source.objectVersion,
          sourcePatientReference: preview.laboratoryReport.patientId,
          decision: 'verified',
          basisCode: 'documented-clinic-procedure',
        })
        .expect(201)
    ).body;
    const binding = {
      patientId: preview.patientId,
      sha256: preview.source.sha256,
      objectVersion: preview.source.objectVersion,
      patientLinkDecisionId: link.id as string,
      sourcePatientReference: preview.laboratoryReport.patientId,
    };
    let revisionId: string | null = null;
    if (options.save !== false) {
      const saved = (await lab.api().post(`/api/v1/reports/${report.id}/structured-preview/record`).set(bearer(uploader.token)).send(binding).expect(201)).body;
      revisionId = saved.record.id as string;
      for (const [findingId, decision] of Object.entries(options.reviews ?? {})) {
        await lab
          .api()
          .post(`/api/v1/reports/${report.id}/structured-preview/review`)
          .set(bearer(reviewer.token))
          .send({
            requestId: randomUUID(),
            revisionId,
            patientId: binding.patientId,
            sha256: binding.sha256,
            objectVersion: binding.objectVersion,
            patientLinkDecisionId: binding.patientLinkDecisionId,
            findingId,
            decision,
            reasonCode: REASON[decision],
          })
          .expect(201);
      }
    }
    return { uploader, reviewer, patientId, reportId: report.id as string, laboratoryId, revisionId, binding };
  }

  return { prepare };
}
