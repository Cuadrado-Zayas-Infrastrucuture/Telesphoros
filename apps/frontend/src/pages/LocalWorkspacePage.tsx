import { useEffect, useRef, useState, type DragEvent } from 'react';
import { Link } from 'react-router-dom';
import { ArrowUp, FileText, Paperclip, Square, X } from 'lucide-react';
import { patientLabelSchema, type PatientDto } from '@telesphoros/shared-types';
import mascot from '@/assets/telesphoros-mascot.png';
import { SessionEndedError, useAuth } from '@/auth/AuthProvider';
import { WRITER_ROLES } from '@/auth/roles';
import { FeedbackBar } from '@/components/prompt-kit/FeedbackBar';
import { Message } from '@/components/prompt-kit/Message';
import { MessageContent } from '@/components/prompt-kit/MessageContent';
import { PromptInput } from '@/components/prompt-kit/PromptInput';
import { PromptInputTextarea } from '@/components/prompt-kit/PromptInputTextarea';
import { PromptSuggestion } from '@/components/prompt-kit/PromptSuggestion';
import { ScrollButton } from '@/components/prompt-kit/ScrollButton';
import { Source } from '@/components/prompt-kit/Source';
import { Steps } from '@/components/prompt-kit/Steps';
import { SystemMessage } from '@/components/prompt-kit/SystemMessage';
import { ThinkingBar } from '@/components/prompt-kit/ThinkingBar';
import { BrandBackdrop } from '@/components/workspace/BrandBackdrop';
import { PastReports } from '@/components/workspace/PastReports';
import { WorkspaceBar } from '@/components/workspace/WorkspaceBar';
import { Button } from '@/components/ui/Button';
import { usePageTitle } from '@/hooks/usePageTitle';
import { useSyntheticChat } from '@/hooks/useSyntheticChat';
import { createPatient, listPatients, SubmitError, submitReport, type UploadProgress } from '@/lib/api';
import { cancelOwnedUpload } from '@/lib/ownedStorageApi';
import { productUploadSchema } from '@/lib/productUploadSchema';
import { DEMO_QUESTIONS } from '@/lib/interpretationDemo';
import { reportTypeFor } from '@/lib/reportTypeFor';
import { readRecovery } from '@/lib/uploadRecovery';
import { UPLOAD_STEPS, UPLOAD_WORDS, uploadStage } from '@/lib/uploadSteps';
import '@/styles/interpretation-preview.css';
import '@/styles/one-screen.css';

const NEW_PATIENT = 'new';
const QUESTION_ID = 'one-screen-question';

interface Sent {
  id: number;
  filename: string;
  patient: string;
  stage: number;
  phase: 'uploading' | 'verified' | 'failed';
  message?: string;
}

/**
 * One screen for the whole flow (specs/016), built on the Prompt Kit parts the app already has (specs/021): drop a report, pick its patient in
 * place, ask. Development preview only; uploads go through the same validated intake as the Upload page, and answers come from the synthetic engine.
 */
export default function LocalWorkspacePage() {
  usePageTitle('Workspace');
  const { roles, apiFetch, recoverySession } = useAuth();
  const allowed = import.meta.env.DEV && location.hostname === '127.0.0.1';
  const chat = useSyntheticChat(allowed);
  const canAttach = roles.some((role) => WRITER_ROLES.includes(role));
  const [patients, setPatients] = useState<PatientDto[] | null>(null);
  const [patientsError, setPatientsError] = useState<string | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [patientId, setPatientId] = useState('');
  const [synthetic, setSynthetic] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [tried, setTried] = useState(false);
  const [newLabel, setNewLabel] = useState('');
  const addRequest = useRef<{ label: string; id: string } | null>(null);
  const [sent, setSent] = useState<Sent[]>([]);
  const [uploading, setUploading] = useState(false);
  const [history, setHistory] = useState(false);
  const [opened, setOpened] = useState(0);
  const [away, setAway] = useState(false);
  const [interrupted] = useState(() => !!readRecovery(recoverySession));
  const picker = useRef<HTMLInputElement>(null);
  const latest = useRef<HTMLDivElement>(null);
  const transfer = useRef<AbortController | null>(null);
  const progress = useRef<UploadProgress>({});

  useEffect(() => {
    if (!canAttach) return;
    const controller = new AbortController();
    listPatients(apiFetch, 1, controller.signal)
      .then((page) => {
        setPatients(page.data);
        setPatientId((current) => current || page.data[0]?.id || NEW_PATIENT);
      })
      .catch((caught: unknown) => {
        if (controller.signal.aborted || caught instanceof SessionEndedError) return;
        setPatientsError(caught instanceof SubmitError ? caught.message : 'Patients could not be loaded. Please retry.');
      });
    return () => controller.abort();
  }, [canAttach, apiFetch]);

  // The page itself scrolls; offer the way back once the reader is well above the newest message.
  useEffect(() => {
    const check = () => setAway(document.documentElement.scrollHeight - (window.scrollY + window.innerHeight) > 240);
    window.addEventListener('scroll', check, { passive: true });
    return () => window.removeEventListener('scroll', check);
  }, []);

  function toLatest() {
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    window.scrollTo({ top: document.documentElement.scrollHeight, behavior: reduced ? 'auto' : 'smooth' });
    latest.current?.focus({ preventScroll: true });
  }

  function choose(next: File | undefined) {
    if (!next) return;
    setFile(next);
    setFileError(reportTypeFor(next.name) ? null : 'Use a .json or .pdf report. Raw genomic data (VCF) is not accepted.');
  }

  function drop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragging(false);
    if (canAttach) choose(event.dataTransfer.files[0]);
  }

  const busy = uploading || !!chat.pending;
  const text = chat.input.trim();
  const adding = patientId === NEW_PATIENT;
  const labelProblem = adding ? patientLabelSchema.safeParse(newLabel).error?.issues[0]?.message : undefined;
  const blocked = file
    ? !patientId
      ? 'Choose the patient first.'
      : labelProblem
        ? labelProblem
        : !synthetic
          ? 'Confirm the file is synthetic.'
          : fileError
    : !text
      ? 'Attach a report or ask a question.'
      : null;
  const attached = [...sent].reverse().find((item) => item.phase === 'verified');

  /** A retry with the same label replays the first request (createPatient's requestId), so a lost response never makes a second patient. */
  async function patientForUpload(): Promise<PatientDto | null> {
    if (!adding) return patients?.find((p) => p.id === patientId) ?? null;
    const label = newLabel.trim();
    if (addRequest.current?.label !== label) addRequest.current = { label, id: crypto.randomUUID() };
    try {
      const created = await createPatient(apiFetch, label, addRequest.current.id);
      addRequest.current = null;
      setPatients((list) => [created, ...(list ?? [])]);
      setPatientId(created.id);
      setNewLabel('');
      return created;
    } catch (error) {
      if (!(error instanceof SessionEndedError)) setFileError(error instanceof SubmitError ? error.message : 'The patient could not be added. Please retry.');
      return null;
    }
  }

  async function send() {
    setTried(true);
    if (busy || blocked) return;
    setTried(false);
    if (file) {
      const patient = await patientForUpload();
      if (!patient) return;
      const reportType = reportTypeFor(file.name);
      const parsed = productUploadSchema.safeParse({ patientId: patient.id, reportType, file, syntheticConfirmed: synthetic });
      if (!parsed.success) {
        setFileError(parsed.error.issues[0]?.message ?? 'This file cannot be uploaded.');
        return;
      }
      const id = Date.now();
      setSent((list) => [...list, { id, filename: file.name, patient: patient.label, stage: 0, phase: 'uploading' }]);
      setUploading(true);
      transfer.current = new AbortController();
      progress.current = {};
      // submitReport updates progress as the server answers; reflect it in the steps while the upload runs.
      const watch = window.setInterval(() => {
        const stage = uploadStage(progress.current.attempt?.state);
        setSent((list) => list.map((item) => (item.id === id && item.stage !== stage ? { ...item, stage } : item)));
      }, 150);
      try {
        await submitReport(parsed.data, apiFetch, progress.current, transfer.current.signal, recoverySession ?? undefined);
        setSent((list) => list.map((item) => (item.id === id ? { ...item, stage: UPLOAD_STEPS.length, phase: 'verified' } : item)));
        setFile(null);
        setSynthetic(false);
      } catch (error) {
        if (error instanceof SessionEndedError) return;
        if (progress.current.cancelRequested) await cancelOwnedUpload(apiFetch, progress.current).catch(() => undefined);
        const message = progress.current.cancelRequested
          ? 'Upload cancelled.'
          : error instanceof SubmitError
            ? error.message
            : 'The upload was interrupted. Your file is kept; please retry.';
        setSent((list) => list.map((item) => (item.id === id ? { ...item, phase: 'failed', message } : item)));
        return;
      } finally {
        window.clearInterval(watch);
        transfer.current = null;
        setUploading(false);
      }
    }
    if (text) await chat.submit(text);
  }

  function stop() {
    if (transfer.current) {
      progress.current.cancelRequested = true;
      transfer.current.abort();
    } else void chat.cancel();
  }

  function startOver() {
    if (busy) return;
    void chat.cancel(true);
    setSent([]);
    setFile(null);
    setSynthetic(false);
    setFileError(null);
    document.getElementById(QUESTION_ID)?.focus();
  }

  const started = sent.length > 0 || chat.turns.length > 0 || !!chat.pending;
  // The synthetic engine answers only these; offering them keeps the preview honest about what it can say.
  const suggestions = !file && !busy && !chat.full && (
    <div className="mt-3 grid gap-2 sm:grid-cols-3" aria-label="Sample questions">
      {DEMO_QUESTIONS.map((sample) => (
        <PromptSuggestion key={sample} onClick={() => void chat.submit(sample)}>
          {sample}
        </PromptSuggestion>
      ))}
    </div>
  );
  const box = (
    <div
      className="one-screen-box"
      data-dragging={dragging}
      onDragOver={(event) => {
        if (!canAttach) return;
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={drop}
    >
      <PromptInput
        label="Report and question"
        value={chat.input}
        onValueChange={chat.setInput}
        onSubmit={() => void send()}
        isLoading={busy}
        allowEmpty={!!file}
        className="border-0 bg-transparent p-0"
      >
        {file && (
          <div className="one-screen-file">
            <FileText aria-hidden="true" className="size-4" />
            <span className="min-w-0 flex-1 truncate font-medium sm:max-w-48 sm:flex-none">{file.name}</span>
            {/* Beside the name on a phone; at the end of the line on wider screens. */}
            <Button variant="ghost" size="sm" className="size-11 p-0 sm:order-last" aria-label="Remove file" onClick={() => setFile(null)}>
              <X aria-hidden="true" className="size-4" />
            </Button>
            <span className="text-muted-foreground">for</span>
            {patients ? (
              <>
                <select aria-label="Patient" value={patientId} onChange={(event) => setPatientId(event.target.value)}>
                  {patients.map((patient) => (
                    <option key={patient.id} value={patient.id}>
                      {patient.label}
                    </option>
                  ))}
                  <option value={NEW_PATIENT}>New synthetic patient…</option>
                </select>
                {adding && (
                  <input
                    aria-label="New patient label"
                    placeholder="e.g. SYN-004"
                    maxLength={40}
                    value={newLabel}
                    onChange={(event) => setNewLabel(event.target.value)}
                    className="h-11 w-32 rounded-md border border-border bg-background px-2"
                  />
                )}
              </>
            ) : (
              <span className="text-muted-foreground">{patientsError ?? 'loading patients…'}</span>
            )}
            <label className="ml-auto inline-flex min-h-11 items-center gap-2">
              <input type="checkbox" className="size-5 accent-primary" checked={synthetic} onChange={(event) => setSynthetic(event.target.checked)} />
              Synthetic
            </label>
            {fileError && (
              <p role="alert" className="order-last w-full text-destructive">
                {fileError}
              </p>
            )}
          </div>
        )}
        <PromptInputTextarea
          id={QUESTION_ID}
          rows={2}
          maxLength={400}
          aria-label={started ? 'Follow-up question' : 'Question'}
          placeholder={started ? 'Ask a follow-up' : file ? 'Ask a question about it (optional)' : canAttach ? 'Attach a report, or ask a question' : 'Ask a question'}
          className="bg-transparent px-1"
        />
        <div className="flex items-center justify-between gap-2">
          {canAttach ? (
            <>
              <input ref={picker} type="file" accept=".json,.pdf" className="sr-only" tabIndex={-1} aria-hidden="true" onChange={(event) => choose(event.target.files?.[0])} />
              <Button variant="ghost" size="sm" className="size-11 rounded-full p-0" aria-label="Attach a report" onClick={() => picker.current?.click()}>
                <Paperclip aria-hidden="true" className="size-5" />
              </Button>
            </>
          ) : (
            <span />
          )}
          {busy ? (
            <Button size="sm" className="size-11 rounded-full p-0" aria-label="Stop" onClick={stop}>
              <Square aria-hidden="true" className="size-4" />
            </Button>
          ) : (
            <Button size="sm" className="size-11 rounded-full p-0" aria-label="Send" aria-disabled={!!blocked} title={blocked ?? undefined} onClick={() => void send()}>
              <ArrowUp aria-hidden="true" className="size-5" />
            </Button>
          )}
        </div>
        {tried && blocked && (
          <p role="status" className="pt-1 text-sm text-muted-foreground">
            {blocked}
          </p>
        )}
      </PromptInput>
    </div>
  );

  return (
    <div className="one-screen">
      <BrandBackdrop />
      <WorkspaceBar
        onNew={startOver}
        onHistory={() => {
          setOpened((n) => n + 1);
          setHistory(true);
        }}
      />
      <PastReports key={opened} open={history} onClose={() => setHistory(false)} />
      {!started ? (
        <div className="one-screen-start flex flex-1 flex-col justify-center">
          <div className="one-screen-column">
            <img className="one-screen-mascot" src={mascot} width="162" height="192" loading="eager" alt="Telesphoros mascot in a teal cloak" />
            <h1 className="mb-6 text-center font-heading text-3xl font-medium">Which report should we read?</h1>
            {box}
            {suggestions}
            <p className="mt-3 text-center text-sm text-muted-foreground">
              {canAttach ? 'Drop a report here, or attach one. Synthetic reports only.' : 'Ask about a synthetic example report.'}
            </p>
            {interrupted && (
              <p className="mt-2 text-center text-sm">
                An earlier upload was interrupted. <Link to="/reports/upload">Finish or cancel it on the upload page</Link>.
              </p>
            )}
          </div>
        </div>
      ) : (
        <>
          <div className="one-screen-column flex flex-1 flex-col gap-5 py-6" aria-live="polite">
            <h1 className="sr-only">Workspace</h1>
            {sent.map((item) => (
              <div key={item.id} className="flex flex-col gap-2 self-end">
                <span className="inline-flex items-center gap-2 self-end rounded-lg border border-divider bg-panel px-3 py-1.5 text-sm">
                  <FileText aria-hidden="true" className="size-4" />
                  {item.filename} · {item.patient}
                </span>
                <Steps stage={item.stage} failed={item.phase === 'failed'} labels={UPLOAD_STEPS} words={UPLOAD_WORDS} label={`Upload of ${item.filename}`} colored />
                {item.phase === 'failed' && <SystemMessage error>{item.message}</SystemMessage>}
              </div>
            ))}
            {chat.turns.map((turn, index) => (
              <div key={turn.id} className="flex flex-col gap-4" ref={index === chat.turns.length - 1 ? latest : undefined} tabIndex={-1}>
                <p className="one-screen-you self-end rounded-2xl bg-surface px-4 py-2">{turn.question}</p>
                <Message>
                  <img className="one-screen-avatar" src={mascot} width="162" height="192" loading="lazy" alt="" />
                  <div className="flex min-w-0 flex-1 flex-col gap-2">
                    <MessageContent>{turn.answer}</MessageContent>
                    <p className="text-xs text-muted-foreground">Sample answer from synthetic data. Not clinical advice.</p>
                    {attached ? (
                      <Source
                        title={`Attached: ${attached.filename} · not read by the sample engine`}
                        description="This answer is a fixed example. The sample engine did not read the attached report, and nothing here is a clinical interpretation."
                      />
                    ) : (
                      <Source />
                    )}
                    <FeedbackBar value={turn.feedback} onChange={(value) => chat.markFeedback(turn.id, value)} />
                  </div>
                </Message>
              </div>
            ))}
            {chat.pending && (
              <>
                <p className="one-screen-you self-end rounded-2xl bg-surface px-4 py-2">{chat.pending}</p>
                <ThinkingBar text={chat.status} stage={chat.stage} onStop={stop} />
              </>
            )}
            {chat.error && <SystemMessage error>{chat.error}</SystemMessage>}
          </div>
          <div className="one-screen-column sticky bottom-0 pt-2 pb-4">
            {away && (
              <div className="mb-2 flex justify-center">
                <ScrollButton onClick={toLatest} />
              </div>
            )}
            {suggestions}
            <div className="mt-2">{box}</div>
          </div>
        </>
      )}
      <div className="one-screen-column pb-3">
        <SystemMessage quiet>Synthetic data only. Not for clinical use.</SystemMessage>
      </div>
    </div>
  );
}
