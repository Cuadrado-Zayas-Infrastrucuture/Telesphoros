import { useEffect, useId, useRef, useState } from 'react';
import {
  LINK_REJECT_BASIS_CODES,
  LINK_VERIFY_BASIS_CODES,
  patientLinkDecisionDtoSchema,
  structuredPreviewSchema,
  type StructuredPreview,
  type StructuredPatientLink,
} from '@telesphoros/shared-types';
import { useAuth } from '@/auth/AuthProvider';
import { Button } from '@/components/ui/Button';
import { StructuredRevisionRecord } from './StructuredRevisionRecord';

export function StructuredPreviewContent({ reportId }: { reportId: string }) {
  const { apiFetch, roles } = useAuth();
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState<StructuredPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [decision, setDecision] = useState<'verified' | 'rejected'>('verified');
  const [basis, setBasis] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [saved, setSaved] = useState(false);
  const current = useRef<AbortController | null>(null);
  const formId = useId();
  useEffect(() => () => current.current?.abort(), []);
  if (!roles.some((r) => r === 'clinician' || r === 'reviewer')) return null;
  const path = `/api/v1/reports/${reportId}/structured-preview`;
  async function requestPreview(signal: AbortSignal) {
    const response = await apiFetch(path, { signal });
    if (!response.ok)
      throw new Error(response.status === 422 ? 'This file is not a supported synthetic package.' : 'The stored findings could not be verified. Retry to read the current file.');
    const value = structuredPreviewSchema.parse(await response.json());
    if (value.reportId !== reportId || value.patientLink.reportId !== reportId || value.patientLink.patientId !== value.patientId)
      throw new Error('The report response did not match. Retry to read the current file.');
    return value;
  }
  async function load() {
    current.current?.abort();
    const controller = new AbortController();
    current.current = controller;
    setBusy(true);
    setError('');
    setPreview(null);
    setConfirmed(false);
    setSaved(false);
    setBasis('');
    try {
      const value = await requestPreview(controller.signal);
      if (!controller.signal.aborted) setPreview(value);
    } catch {
      if (!controller.signal.aborted) setError('Findings unavailable. Check that this is a supported synthetic package, then retry.');
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  async function save() {
    if (!preview || !confirmed || !basis || busy || !preview.canReview || !roles.includes('reviewer')) return;
    const controller = new AbortController();
    current.current?.abort();
    current.current = controller;
    const body = {
      patientId: preview.patientId,
      ...preview.source,
      sourcePatientReference: preview.laboratoryReport.patientId,
      decision,
      basisCode: basis,
    } as StructuredPatientLink;
    setBusy(true);
    setError('');
    setSaved(false);
    setConfirmed(false);
    try {
      const response = await apiFetch(`${path}/patient-link`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error('Decision not confirmed.');
      patientLinkDecisionDtoSchema.parse(await response.json());
      const value = await requestPreview(controller.signal);
      if (!controller.signal.aborted) {
        setPreview(value);
        setSaved(true);
        setBasis('');
      }
    } catch {
      if (!controller.signal.aborted) {
        setPreview(null);
        setError('The decision could not be confirmed. Reload the current review before trying again; a completed decision may already be recorded.');
      }
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  const lab = preview?.laboratoryReport;
  const reasons = decision === 'verified' ? LINK_VERIFY_BASIS_CODES : LINK_REJECT_BASIS_CODES;
  return (
    <section className="min-w-0 border-t border-divider pt-2" aria-label="Structured report inspection">
      <Button
        variant="outline"
        className="h-auto min-h-control w-full whitespace-normal"
        aria-expanded={open}
        onClick={() => {
          setOpen(!open);
          if (!open && !preview && !busy) void load();
        }}
      >
        {open ? 'Hide structured findings' : 'Show structured findings'}
      </Button>
      {open && (
        <div className="mt-3 space-y-3 text-sm" aria-busy={busy}>
          <p className="text-muted-foreground">Synthetic source evidence. Patient matching does not approve these findings or generate prescribing advice.</p>
          {busy && <p role="status">{preview ? 'Recording and checking the decision…' : 'Reading the pinned file…'}</p>}
          {error && (
            <>
              <p role="alert">{error}</p>
              <Button variant="outline" disabled={busy} onClick={() => void load()}>
                Reload findings
              </Button>
            </>
          )}
          {preview && lab && (
            <>
              <dl className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                <div>
                  <dt className="text-muted-foreground">Selected patient</dt>
                  <dd className="break-words">{preview.patientLabel}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Patient reference on file</dt>
                  <dd className="break-words">{lab.patientId}</dd>
                </div>
              </dl>
              <p>
                Patient link: <strong>{preview.patientLink.state}</strong>
                {preview.patientLink.staleDecision && ' — earlier decision is stale'}
              </p>
              {preview.patientLink.decision && (
                <p className="text-xs text-muted-foreground">Latest reason: {words(preview.patientLink.decision.basisCode ?? preview.patientLink.decision.method)}</p>
              )}
              {saved && <p role="status">Patient-link decision recorded. Findings remain source evidence only.</p>}
              <p className="break-words">
                {lab.laboratoryId} · {lab.accession} · Revision {lab.revision} ({lab.status})
              </p>
              {lab.previousRevisionId && <p className="break-words">Declared predecessor: {lab.previousRevisionId}.</p>}
              <ul aria-label="Laboratory findings" className="divide-y divide-divider">
                {lab.findings.map((finding) => (
                  <li key={finding.id} className="space-y-1 break-words py-3">
                    <p className="font-semibold">
                      {finding.gene} — {finding.reportedCall?.originalText ?? 'No reported call'}
                    </p>
                    <p>
                      {words(finding.coverage)} · {words(finding.analyticalState)} · {words(finding.interpretationState)}
                    </p>
                    {finding.reportedCall?.kind === 'unresolved' && <p>Candidates: {finding.reportedCall.candidates.join(', ')}</p>}
                    {finding.laboratoryInterpretation && (
                      <p>
                        Laboratory interpretation: {finding.laboratoryInterpretation.phenotype ?? 'No phenotype'}
                        {finding.laboratoryInterpretation.activityScore !== null && ` · Activity score ${finding.laboratoryInterpretation.activityScore}`}
                      </p>
                    )}
                    {finding.limitations.map((limitation, i) => (
                      <p key={i} className="text-muted-foreground">
                        {limitation}
                      </p>
                    ))}
                  </li>
                ))}
              </ul>
              {lab.findings.length === 0 && <p>No findings supplied.</p>}
              {lab.limitations.map((limitation, i) => (
                <p key={i} className="text-muted-foreground">
                  {limitation}
                </p>
              ))}
              <details>
                <summary className="min-h-control cursor-pointer py-3 font-semibold">Assay and source details</summary>
                <div className="space-y-2 break-words">
                  <p>Report: {lab.id}</p>
                  <p>
                    Specimen: {lab.specimen.type} · {lab.specimen.collectedAt}
                  </p>
                  <p>Issued: {lab.issuedAt}</p>
                  {lab.assay.state === 'provided' ? (
                    <>
                      <p>
                        Assay: {lab.assay.manifest.id} · {lab.assay.manifest.version}
                      </p>
                      <p>{lab.assay.manifest.method}</p>
                      {lab.assay.manifest.limitations.map((l, i) => (
                        <p key={i}>{l}</p>
                      ))}
                    </>
                  ) : (
                    <p>Assay unavailable: {lab.assay.reason}</p>
                  )}
                  <p className="break-all text-xs">SHA-256: {preview.source.sha256}</p>
                  <p className="break-all text-xs">File version: {preview.source.objectVersion}</p>
                </div>
              </details>
              {preview.canReview && roles.includes('reviewer') ? (
                <details key={preview.patientLink.decision?.id ?? 'unreviewed'}>
                  <summary className="min-h-control cursor-pointer py-3 font-semibold">Review patient link</summary>
                  <form
                    className="space-y-3"
                    onSubmit={(event) => {
                      event.preventDefault();
                      void save();
                    }}
                  >
                    <label className="block" htmlFor={`${formId}-decision`}>
                      Patient-link decision
                    </label>
                    <select
                      id={`${formId}-decision`}
                      className="min-h-control w-full rounded-md border border-border bg-background px-3"
                      value={decision}
                      disabled={busy}
                      onChange={(event) => {
                        setDecision(event.target.value as 'verified' | 'rejected');
                        setBasis('');
                        setConfirmed(false);
                        setSaved(false);
                      }}
                    >
                      <option value="verified">Confirm patient match</option>
                      <option value="rejected">Reject patient match</option>
                    </select>
                    <label className="block" htmlFor={`${formId}-reason`}>
                      Reason for decision
                    </label>
                    <select
                      id={`${formId}-reason`}
                      className="min-h-control w-full rounded-md border border-border bg-background px-3"
                      value={basis}
                      disabled={busy}
                      required
                      onChange={(event) => {
                        setBasis(event.target.value);
                        setConfirmed(false);
                      }}
                    >
                      <option value="">Select a reason</option>
                      {reasons.map((code) => (
                        <option key={code} value={code}>
                          {words(code)}
                        </option>
                      ))}
                    </select>
                    <label className="flex min-h-control cursor-pointer items-center gap-3">
                      <input type="checkbox" checked={confirmed} disabled={busy} onChange={(event) => setConfirmed(event.target.checked)} />
                      <span>I checked the file’s patient reference against the selected patient and confirm this decision.</span>
                    </label>
                    <Button type="submit" className="h-auto min-h-control whitespace-normal" disabled={busy || !confirmed || !basis}>
                      Record patient-link decision
                    </Button>
                  </form>
                </details>
              ) : (
                <p className="text-muted-foreground">An independent reviewer must decide the patient link. Anyone who registered or uploaded this report cannot review it.</p>
              )}
              {!busy && (
                <StructuredRevisionRecord key={`${preview.source.sha256}:${preview.source.objectVersion}:${preview.patientLink.decision?.id ?? 'unreviewed'}`} preview={preview} />
              )}
            </>
          )}
        </div>
      )}
    </section>
  );
}
function words(value: string) {
  return value.replaceAll('-', ' ');
}
