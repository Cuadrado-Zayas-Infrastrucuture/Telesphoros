import { useEffect, useRef, useState, type DragEvent } from 'react';
import { Link } from 'react-router-dom';
import { ArrowUp, FileText, Paperclip, Square, X } from 'lucide-react';
import { patientLabelSchema, type PatientDto, type ReportStatus } from '@telesphoros/shared-types';
import mascot from '@/assets/telesphoros-mascot.png';
import { SessionEndedError, useAuth } from '@/auth/AuthProvider';
import { WRITER_ROLES } from '@/auth/roles';
import { PromptInput } from '@/components/prompt-kit/PromptInput';
import { PromptInputTextarea } from '@/components/prompt-kit/PromptInputTextarea';
import { Steps } from '@/components/prompt-kit/Steps';
import { SystemMessage } from '@/components/prompt-kit/SystemMessage';
import { PatientPicker } from '@/components/PatientPicker';
import { Input } from '@/components/ui/Input';
import { ReportStatusText } from '@/components/ReportStatusText';
import { Button } from '@/components/ui/Button';
import { INCOMPLETE_PROMPT } from '@/components/patients/IncompleteWord';
import { incompleteness } from '@/lib/demographicsDraft';
import { createPatient, listPatients, SubmitError, submitReport, type UploadProgress } from '@/lib/api';
import { cancelOwnedUpload, listReports } from '@/lib/ownedStorageApi';
import { productUploadSchema } from '@/lib/productUploadSchema';
import { reportTypeFor } from '@/lib/reportTypeFor';
import { readRecovery } from '@/lib/uploadRecovery';
import { UPLOAD_STEPS, UPLOAD_WORDS, uploadStage } from '@/lib/uploadSteps';
import { chatFileAccept, fileProblem } from '@/lib/workspaceFileRule';
import { announcePatientAdded, announceReportsChanged, onPatientAdded } from '@/lib/workspaceEvents';
import '@/styles/one-screen.css';

const NEW_PATIENT = 'new';
const QUESTION_ID = 'workspace-question';
const CONFIRMATION = 'I confirm this file contains synthetic data only';
/** The only reply to a typed question outside the local preview (specs/024 D3): a note, never an answer. */
const NOT_AVAILABLE = 'Interpretation is not available in the prototype yet.';

type Entry =
  | { kind: 'question'; id: number; text: string }
  | {
      kind: 'upload';
      id: number;
      filename: string;
      patient: string;
      patientId: string;
      stage: number;
      phase: 'uploading' | 'sent' | 'failed';
      message?: string;
      reportId?: string;
      status?: ReportStatus;
      checking?: boolean;
      checkNote?: string;
    };

/**
 * The chat home's conversation (specs/024): attach a synthetic report, choose its patient, confirm it is synthetic, send. The report appears with its status
 * word and a "Check status" action. A typed question gets a note, not an answer: there is no interpretation outside the local preview, and no request is made.
 * The parent remounts this (a new key) for "New chat", which is how a conversation starts empty.
 */
export function WorkspaceConversation() {
  const { roles, apiFetch, recoverySession } = useAuth();
  const canAttach = roles.some((role) => WRITER_ROLES.includes(role));
  const [patients, setPatients] = useState<PatientDto[] | null>(null);
  const [patientsError, setPatientsError] = useState<string | null>(null);
  // Bumped by Retry: reloading the page instead would sign this tab out (the sign-in is held in memory only).
  const [patientsAttempt, setPatientsAttempt] = useState(0);
  const [file, setFile] = useState<File | null>(null);
  const [patientId, setPatientId] = useState('');
  const [synthetic, setSynthetic] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [tried, setTried] = useState(false);
  const [newLabel, setNewLabel] = useState('');
  const [input, setInput] = useState('');
  const [entries, setEntries] = useState<Entry[]>([]);
  const [uploading, setUploading] = useState(false);
  const [interrupted] = useState(() => !!readRecovery(recoverySession));
  const addRequest = useRef<{ label: string; id: string } | null>(null);
  const counter = useRef(0);
  const picker = useRef<HTMLInputElement>(null);
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
    // A patient added in the panel joins this choice at once.
    const stop = onPatientAdded((patient) => {
      setPatients((list) => (list?.some((p) => p.id === patient.id) ? list : [patient, ...(list ?? [])]));
      setPatientId((current) => (current && current !== NEW_PATIENT ? current : patient.id));
    });
    return () => {
      controller.abort();
      stop();
    };
  }, [canAttach, apiFetch, patientsAttempt]);

  const update = (id: number, change: Partial<Extract<Entry, { kind: 'upload' }>>) =>
    setEntries((list) => list.map((entry) => (entry.id === id && entry.kind === 'upload' ? { ...entry, ...change } : entry)));

  function choose(next: File | undefined) {
    if (!next) return;
    setFile(next);
    setFileError(fileProblem(next.name));
  }

  function drop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragging(false);
    if (canAttach) choose(event.dataTransfer.files[0]);
  }

  const text = input.trim();
  const adding = patientId === NEW_PATIENT;
  const chosen = adding ? null : patients?.find((p) => p.id === patientId);
  const chosenIncomplete = adding || (chosen ? incompleteness(chosen) === 'incomplete' : false);
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
      ? canAttach
        ? 'Attach a report or ask a question.'
        : 'Type a question.'
      : null;

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
      announcePatientAdded(created);
      return created;
    } catch (error) {
      if (!(error instanceof SessionEndedError)) setFileError(error instanceof SubmitError ? error.message : 'The patient could not be added. Please retry.');
      return null;
    }
  }

  /** The report's status word, read from the list. Not finding it is said plainly rather than guessed. */
  async function readStatus(id: number, reportId: string, forPatientId: string, announce: boolean) {
    update(id, { checking: true, checkNote: undefined });
    try {
      const page = await listReports(apiFetch, 1, undefined, forPatientId);
      const found = page.data.find((report) => report.id === reportId);
      update(id, found ? { status: found.status, checking: false } : { checking: false, checkNote: 'This report is not in the latest list yet. Check again shortly.' });
      if (announce) announceReportsChanged();
    } catch (error) {
      if (error instanceof SessionEndedError) return;
      update(id, { checking: false, checkNote: 'The status could not be loaded. Please retry.' });
    }
  }

  async function send() {
    setTried(true);
    if (uploading || blocked) return;
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
      const id = ++counter.current;
      setEntries((list) => [...list, { kind: 'upload', id, filename: file.name, patient: patient.label, patientId: patient.id, stage: 0, phase: 'uploading' }]);
      setUploading(true);
      transfer.current = new AbortController();
      progress.current = {};
      const watch = window.setInterval(() => update(id, { stage: uploadStage(progress.current.attempt?.state) }), 150);
      let reportId: string;
      try {
        reportId = (await submitReport(parsed.data, apiFetch, progress.current, transfer.current.signal, recoverySession ?? undefined)).reference;
        update(id, { stage: UPLOAD_STEPS.length, phase: 'sent', reportId, status: 'received' });
        setFile(null);
        setSynthetic(false);
      } catch (error) {
        if (error instanceof SessionEndedError) return;
        if (progress.current.cancelRequested) await cancelOwnedUpload(apiFetch, progress.current).catch(() => undefined);
        update(id, {
          phase: 'failed',
          message: progress.current.cancelRequested
            ? 'Upload cancelled.'
            : error instanceof SubmitError
              ? error.message
              : 'The upload was interrupted. Your file is kept; please retry.',
        });
        return;
      } finally {
        window.clearInterval(watch);
        transfer.current = null;
        setUploading(false);
      }
      announceReportsChanged();
      void readStatus(id, reportId, patient.id, false);
    }
    if (text) {
      setEntries((list) => [...list, { kind: 'question', id: ++counter.current, text }]);
      setInput('');
    }
  }

  function stop() {
    if (!transfer.current) return;
    progress.current.cancelRequested = true;
    transfer.current.abort();
  }

  const started = entries.length > 0;
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
        value={input}
        onValueChange={setInput}
        onSubmit={() => void send()}
        isLoading={uploading}
        allowEmpty={!!file}
        className="border-0 bg-transparent p-0"
      >
        {file && (
          <div className="one-screen-file">
            <div className="flex items-center gap-2">
              <FileText aria-hidden="true" className="size-4 shrink-0" />
              <span className="min-w-0 flex-1 truncate font-medium">{file.name}</span>
              <Button variant="ghost" size="sm" className="size-11 shrink-0 p-0" aria-label="Remove file" onClick={() => setFile(null)}>
                <X aria-hidden="true" className="size-4" />
              </Button>
            </div>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="text-muted-foreground">for</span>
              <PatientPicker
                aria-label="Patient"
                patients={patients}
                value={patientId}
                onValueChange={setPatientId}
                disabled={uploading}
                error={patientsError}
                newPatientOption={{ value: NEW_PATIENT, label: 'New synthetic patient…' }}
                onRetry={() => {
                  setPatientsError(null);
                  setPatientsAttempt((attempt) => attempt + 1);
                }}
              />
              {adding && (
                <div className="flex min-w-0 flex-col gap-1">
                  <Input
                    aria-label="New patient label"
                    aria-describedby="workspace-new-patient-help"
                    placeholder="e.g. SYN-004"
                    maxLength={40}
                    value={newLabel}
                    disabled={uploading}
                    onChange={(event) => setNewLabel(event.target.value)}
                  />
                  <p id="workspace-new-patient-help" className="text-xs text-muted-foreground">
                    Letters, numbers and hyphens. A code, never a name.
                  </p>
                </div>
              )}
            </div>
            {/* Spec 025 T302: one line, never blocking. A new patient made here has a label only, so it starts Incomplete. */}
            {chosenIncomplete && <p className="text-warning">{INCOMPLETE_PROMPT}</p>}
            <label className="inline-flex min-h-11 items-center gap-2">
              <input type="checkbox" className="size-5 shrink-0 accent-primary" checked={synthetic} onChange={(event) => setSynthetic(event.target.checked)} />
              {CONFIRMATION}
            </label>
            {fileError && (
              <p role="alert" className="text-destructive">
                {fileError}
              </p>
            )}
          </div>
        )}
        <PromptInputTextarea
          id={QUESTION_ID}
          rows={2}
          maxLength={400}
          aria-label="Question"
          placeholder={file ? 'Add a note (optional)' : canAttach ? 'Attach a report, or ask a question' : 'Ask a question'}
          className="bg-transparent px-1"
        />
        <div className="flex items-center justify-between gap-2">
          {canAttach ? (
            <>
              <input
                ref={picker}
                type="file"
                accept={chatFileAccept()}
                className="sr-only"
                tabIndex={-1}
                aria-hidden="true"
                onChange={(event) => choose(event.target.files?.[0])}
              />
              <Button variant="ghost" size="sm" className="size-11 rounded-full p-0" aria-label="Attach a report" onClick={() => picker.current?.click()}>
                <Paperclip aria-hidden="true" className="size-5" />
              </Button>
            </>
          ) : (
            <span />
          )}
          {uploading ? (
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
    <div className="chat-home">
      <div className="one-screen-column flex flex-1 flex-col">
        {!started ? (
          <div className="flex flex-1 flex-col justify-center py-6">
            <img className="one-screen-mascot mascot-plate" src={mascot} width="162" height="192" loading="eager" alt="Telesphoros mascot in a teal cloak" />
            {/* The prototype does not interpret reports yet, so the heading does not promise a reading (specs/024 D3). */}
            <h1 className="mb-3 text-center font-heading text-3xl font-medium">Start with a synthetic report.</h1>
            <p className="text-center text-sm text-muted-foreground">
              {canAttach ? 'Drop a report here, or attach one. Synthetic reports only.' : 'Typed questions are noted; reports are attached by clinicians.'}
            </p>
          </div>
        ) : (
          <section aria-label="Conversation" aria-live="polite" className="flex flex-1 flex-col gap-5 py-6">
            <h1 className="sr-only">Workspace</h1>
            {entries.map((entry) =>
              entry.kind === 'question' ? (
                <div key={entry.id} className="flex flex-col gap-3">
                  <p className="one-screen-you self-end rounded-2xl bg-surface px-4 py-2 break-words">{entry.text}</p>
                  <SystemMessage>{NOT_AVAILABLE}</SystemMessage>
                </div>
              ) : (
                <div key={entry.id} className="flex flex-col gap-2">
                  <span className="inline-flex max-w-full items-center gap-2 self-end rounded-lg border border-divider bg-panel px-3 py-1.5 text-sm">
                    <FileText aria-hidden="true" className="size-4 shrink-0" />
                    <span className="min-w-0 truncate">
                      {entry.filename} · {entry.patient}
                    </span>
                  </span>
                  <Steps stage={entry.stage} failed={entry.phase === 'failed'} labels={UPLOAD_STEPS} words={UPLOAD_WORDS} label={`Upload of ${entry.filename}`} colored />
                  {entry.phase === 'failed' && <SystemMessage error>{entry.message}</SystemMessage>}
                  {entry.phase === 'sent' && entry.status && (
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                      <span className="text-muted-foreground">Report status</span>
                      <ReportStatusText status={entry.status} className="font-medium" />
                      <Button variant="outline" size="sm" disabled={entry.checking} onClick={() => void readStatus(entry.id, entry.reportId!, entry.patientId, true)}>
                        Check status
                      </Button>
                      {entry.checkNote && <span className="text-muted-foreground">{entry.checkNote}</span>}
                    </div>
                  )}
                </div>
              ),
            )}
          </section>
        )}
      </div>
      <div className="one-screen-column sticky bottom-0 bg-background pt-2 pb-3">
        {box}
        <div className="mt-3">
          <SystemMessage quiet>Synthetic data only. Not for clinical use.</SystemMessage>
        </div>
        {interrupted && (
          <p className="mt-2 text-center text-sm">
            An earlier upload was interrupted. <Link to="/reports/upload">Finish or cancel it on the upload page</Link>.
          </p>
        )}
      </div>
    </div>
  );
}
