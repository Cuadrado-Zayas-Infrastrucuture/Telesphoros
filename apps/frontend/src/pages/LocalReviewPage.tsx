import { z } from 'zod';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Checkbox } from '@/components/ui/Checkbox';
import { FieldError } from '@/components/ui/FieldError';
import d01Preview from '@/assets/local-D01.svg';
import { Link } from 'react-router-dom';
import { useState, useRef, useEffect } from 'react';
import { captureDtoSchema, fileLinkDtoSchema, evaluationDtoSchema, type CaptureDto } from '@telesphoros/shared-types';
import { useAuth } from '@/auth/AuthProvider';
import { usePageTitle } from '@/hooks/usePageTitle';
import { submitReport, localStorageOrigin, type UploadProgress } from '@/lib/localReportApi';

export default function LocalReviewPage() {
  usePageTitle('Local synthetic PDF review');
  const { apiFetch, roles } = useAuth();
  const [file, setFile] = useState<File>();
  const [label, setLabel] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [captureId, setCaptureId] = useState('');
  const [capture, setCapture] = useState<CaptureDto>();
  const [pdf, setPdf] = useState('');
  const [text, setText] = useState('');
  const [compared, setCompared] = useState(false);
  const [result, setResult] = useState('');
  const [linked, setLinked] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [fields, setFields] = useState<Record<string, string>>({});
  const locked = useRef(false);
  useEffect(() => {
    if (!busy) {
      const first = Object.keys(fields)[0];
      if (first) document.getElementById(first)?.focus();
    }
  }, [fields, busy]);
  function invalid(errors: Record<string, string>) {
    setFields(errors);
    const first = Object.keys(errors)[0];
    if (first) document.getElementById(first)?.focus();
    return !!first;
  }
  const progress = useRef<UploadProgress>({});
  async function json(path: string, body?: unknown) {
    if (!import.meta.env.DEV || window.location.hostname !== '127.0.0.1') throw new Error('Local experiment only.');
    const r = await apiFetch(
      '/api/v1' + path,
      body === undefined
        ? {}
        : {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          },
    );
    if (!r.ok) throw new Error(`Request refused (${r.status}). No approval is inferred.`);
    return r.json();
  }
  async function link(path: string) {
    const value = fileLinkDtoSchema.parse(await json(path));
    if (new URL(value.url).origin !== localStorageOrigin()) throw new Error('File destination is not the local emulator.');
    return value.url;
  }
  async function load(id: string) {
    setCapture(undefined);
    setPdf('');
    setText('');
    setCompared(false);
    setResult('');
    setLinked(false);
    const c = captureDtoSchema.parse(await json('/captures/' + id));
    const p = await link('/reports/' + c.reportId + '/download-url');
    const t = await link('/captures/' + c.id + '/text-url');
    const r = await fetch(t, { credentials: 'omit', redirect: 'error' });
    if (!r.ok) throw new Error('Stored text could not be loaded.');
    setText(await r.text());
    setPdf(p);
    setCapture(c);
    setCaptureId(c.id);
  }
  async function act(work: () => Promise<void>) {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    setError('');
    try {
      await work();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Step failed.');
    } finally {
      locked.current = false;
      setBusy(false);
    }
  }
  async function upload() {
    const errors: Record<string, string> = {};
    if (!/^SYN-[A-Za-z0-9-]+$/.test(label) || label.length > 40) errors['synthetic-label'] = 'Enter a SYN- label.';
    if (!file || !file.name.toLowerCase().endsWith('.pdf') || file.size > 10 * 1024 * 1024) errors['pdf-fixture'] = 'Choose a PDF fixture of 10 MB or less.';
    if (!confirmed) errors['synthetic-confirmed'] = 'Confirm that this file contains synthetic data only.';
    if (invalid(errors)) return;
    const r = await submitReport(
      {
        file: file!,
        patientLabel: label,
        reportType: 'lab-pdf',
        syntheticConfirmed: confirmed,
      },
      apiFetch,
      progress.current,
    );
    const c = captureDtoSchema.parse(await json('/reports/' + r.reference + '/capture', {}));
    await load(c.id);
  }
  async function openCapture() {
    if (invalid(z.uuid().safeParse(captureId).success ? {} : { 'capture-id': 'Enter a valid capture ID.' })) return;
    await load(captureId);
  }
  async function decide(decision: 'accepted' | 'rejected') {
    if (!capture || !compared || !roles.includes('reviewer')) throw new Error('Reviewer comparison is required.');
    await json('/captures/' + capture.id + '/decision', { decision });
    await load(capture.id);
  }
  async function verifyLink() {
    if (!capture || !compared || !roles.includes('reviewer')) throw new Error('Reviewer comparison is required.');
    // The weaker, coded attestation: the registered identifier route is for a screen that does not exist yet.
    await json('/reports/' + capture.reportId + '/patient-link/decisions', {
      decision: 'verified',
      method: 'person-confirmed',
      basisCode: 'documented-clinic-procedure',
    });
    setLinked(true);
  }
  async function evaluate() {
    if (!capture || capture.latestDecision?.decision !== 'accepted') throw new Error('Current accepted capture required.');
    const e = evaluationDtoSchema.parse(
      await json('/reports/' + capture.reportId + '/evaluations', {
        captureId: capture.id,
        acceptanceId: capture.latestDecision.id,
      }),
    );
    setResult(JSON.stringify(e, null, 2));
  }
  return (
    <div className="min-w-0 space-y-6">
      <h1 className="text-2xl">Local synthetic PDF review</h1>
      <Button asChild variant="outline" className="h-auto min-h-control whitespace-normal py-2">
        <Link to="/local-upload">JSON and VCF upload</Link>
      </Button>{' '}
      <Button asChild variant="outline" className="h-auto min-h-control whitespace-normal py-2">
        <Link to="/local-operations">Evaluation history, corrections and disputes</Link>
      </Button>
      <p>
        Synthetic fixture only. Capture runner is shown below. Clinical use: not approved. Sign in as alice to upload, then sign out and sign in as gina to review. Copy the capture
        ID before switching.
      </p>
      <fieldset disabled={busy} className="min-w-0 space-y-3">
        <legend>1. Upload a known synthetic fixture</legend>
        <label htmlFor="synthetic-label" className="block">
          Synthetic label{' '}
          <Input
            id="synthetic-label"
            aria-label="Synthetic label"
            aria-invalid={!!fields['synthetic-label']}
            aria-describedby={fields['synthetic-label'] ? 'synthetic-label-error' : undefined}
            value={label}
            onChange={(e) => setLabel(e.target.value)}
          />
        </label>
        <FieldError id="synthetic-label-error" message={fields['synthetic-label']} />
        <label htmlFor="pdf-fixture" className="block">
          PDF fixture{' '}
          <Input
            id="pdf-fixture"
            aria-label="PDF fixture"
            aria-invalid={!!fields['pdf-fixture']}
            aria-describedby={fields['pdf-fixture'] ? 'pdf-fixture-error' : undefined}
            type="file"
            accept=".pdf"
            onChange={(e) => setFile(e.target.files?.[0])}
          />
        </label>
        <FieldError id="pdf-fixture-error" message={fields['pdf-fixture']} />
        <label htmlFor="synthetic-confirmed" className="flex min-h-control items-center gap-3">
          <Checkbox
            id="synthetic-confirmed"
            aria-invalid={!!fields['synthetic-confirmed']}
            aria-describedby={fields['synthetic-confirmed'] ? 'synthetic-confirmed-error' : undefined}
            checked={confirmed}
            onChange={(e) => setConfirmed(e.target.checked)}
          />{' '}
          This file contains synthetic data only
        </label>
        <FieldError id="synthetic-confirmed-error" message={fields['synthetic-confirmed']} />
        <Button onClick={() => void act(upload)}>Upload and capture</Button>
      </fieldset>
      <fieldset disabled={busy} className="min-w-0 space-y-3">
        <legend>2. Open capture for comparison</legend>
        <label htmlFor="capture-id" className="block">
          Capture ID
          <Input
            id="capture-id"
            aria-label="Capture ID"
            aria-invalid={!!fields['capture-id']}
            aria-describedby={fields['capture-id'] ? 'capture-id-error' : undefined}
            value={captureId}
            onChange={(e) => setCaptureId(e.target.value)}
          />
        </label>
        <FieldError id="capture-id-error" message={fields['capture-id']} />
        <Button onClick={() => void act(openCapture)}>Open capture</Button>
      </fieldset>
      {capture && (
        <section className="min-w-0 space-y-3">
          <p className="break-all">
            Capture ID: {capture.id}. Runner: {capture.runner}. Decision: {capture.latestDecision?.decision ?? 'pending'}.
          </p>
          <div className="grid min-w-0 gap-4 md:grid-cols-2">
            <div className="min-w-0">
              <Button asChild variant="outline" className="h-auto min-h-control whitespace-normal py-2">
                <a href={pdf} target="_blank" rel="noreferrer">
                  Open source PDF in a separate tab
                </a>
              </Button>
              {capture.pdfSha256 === '6b6d2a4578ac5ca2ac49db080d440320f3341b81ea0b81a7e29113a166c893f0' ? (
                <img src={d01Preview} alt="Rendered source PDF, D01 synthetic fixture" className="w-full" width="612" height="792" loading="lazy" />
              ) : (
                <p>No registered preview. Open the original PDF above before reviewing.</p>
              )}
            </div>
            <pre role="region" aria-label="Stored report text" tabIndex={0} className="h-96 overflow-auto border p-3 whitespace-pre-wrap break-all">
              {text}
            </pre>
          </div>
          <label htmlFor="localreviewpage-control-5" className="flex min-h-control items-center gap-3">
            <Checkbox id="localreviewpage-control-5" disabled={busy} checked={compared} onChange={(e) => setCompared(e.target.checked)} /> I compared the PDF and stored text,
            including field associations
          </label>
          <Button disabled={busy || !compared || !roles.includes('reviewer')} onClick={() => void act(() => decide('accepted'))}>
            Accept capture
          </Button>{' '}
          <Button disabled={busy || !compared || !roles.includes('reviewer')} onClick={() => void act(() => decide('rejected'))}>
            Reject capture
          </Button>
          <Button disabled={busy || !compared || !roles.includes('reviewer')} onClick={() => void act(verifyLink)}>
            Confirm this report belongs to its patient
          </Button>
          {linked && <p role="status">Patient link recorded as verified.</p>}
          <p>
            The API independently refuses decisions by anyone who created, uploaded, completed or captured this report. An evaluation also needs a second person to have confirmed
            that the report belongs to its patient.
          </p>
          <Button disabled={busy || capture.latestDecision?.decision !== 'accepted'} onClick={() => void act(evaluate)}>
            Run synthetic evaluation
          </Button>
        </section>
      )}
      {error && <p role="alert">{error}</p>}
      {busy && <p role="status">Working locally…</p>}
      {result && (
        <pre role="region" aria-label="Stored report text" tabIndex={0} className="max-w-full overflow-auto rounded-md border border-border p-3">
          {result}
        </pre>
      )}
    </div>
  );
}
