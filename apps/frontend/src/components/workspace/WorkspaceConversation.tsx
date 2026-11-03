import { useEffect, useRef, useState, type DragEvent } from 'react';
import { Link } from 'react-router-dom';
import { ArrowUp, FileText, Paperclip, Square, X } from 'lucide-react';
import { type ReportStatus } from '@telesphoros/shared-types';
import mascot from '@/assets/telesphoros-mascot.png';
import { SessionEndedError, useAuth } from '@/auth/AuthProvider';
import { WRITER_ROLES } from '@/auth/roles';
import { PromptInput } from '@/components/prompt-kit/PromptInput';
import { PromptInputTextarea } from '@/components/prompt-kit/PromptInputTextarea';
import { Steps } from '@/components/prompt-kit/Steps';
import { SystemMessage } from '@/components/prompt-kit/SystemMessage';
import { PatientPicker } from '@/components/PatientPicker';
import { Input } from '@/components/ui/Input';
import { useWorkspacePatients } from '@/hooks/useWorkspacePatients';
import { ReportStatusText } from '@/components/ReportStatusText';
import { Button } from '@/components/ui/Button';
import { ContextDrawer } from '@/components/ui/ContextDrawer';
import { INCOMPLETE_PROMPT } from '@/components/patients/IncompleteWord';
import { incompleteness } from '@/lib/demographicsDraft';
import { SubmitError, submitReport, type UploadProgress } from '@/lib/api';
import { cancelOwnedUpload, listReports } from '@/lib/ownedStorageApi';
import { productUploadSchema } from '@/lib/productUploadSchema';
import { reportTypeFor } from '@/lib/reportTypeFor';
import { readRecovery } from '@/lib/uploadRecovery';
import { UPLOAD_STEPS, UPLOAD_WORDS, uploadStage } from '@/lib/uploadSteps';
import { chatFileAccept, fileProblem } from '@/lib/workspaceFileRule';
import { announceReportsChanged, onPatientAdded } from '@/lib/workspaceEvents';
import '@/styles/one-screen.css';

const ATTACHMENT_UNDO_MS = 8_000;
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
      note?: string;
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
export function WorkspaceConversation({ active = true }: { active?: boolean }) {
  const { roles, apiFetch, recoverySession, preferredName } = useAuth();
  const canAttach = roles.some((role) => WRITER_ROLES.includes(role));
  const { patients, loading: patientsLoading, error: patientsError, hasMore: morePatients, loadMore: loadPatients } = useWorkspacePatients(canAttach);
  const [file, setFile] = useState<File | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [removedFile, setRemovedFile] = useState<File | null>(null);
  const [undoPaused, setUndoPaused] = useState(false);
  const [selectedPatientId, setPatientId] = useState('');
  const patientId = selectedPatientId || patients?.[0]?.id || '';
  const [synthetic, setSynthetic] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [tried, setTried] = useState(false);
  const [input, setInput] = useState('');
  const [entries, setEntries] = useState<Entry[]>([]);
  const [uploading, setUploading] = useState(false);
  const [interrupted] = useState(() => !!readRecovery(recoverySession));
  const counter = useRef(0);
  const picker = useRef<HTMLInputElement>(null);
  const transfer = useRef<AbortController | null>(null);
  const sending = useRef(false);
  const progress = useRef<UploadProgress>({});

  useEffect(() => onPatientAdded((patient) => setPatientId(patient.id)), []);

  useEffect(() => {
    if (!removedFile || undoPaused) return;
    const timer = window.setTimeout(() => setRemovedFile(null), ATTACHMENT_UNDO_MS);
    return () => window.clearTimeout(timer);
  }, [removedFile, undoPaused]);

  const update = (id: number, change: Partial<Extract<Entry, { kind: 'upload' }>>) =>
    setEntries((list) => list.map((entry) => (entry.id === id && entry.kind === 'upload' ? { ...entry, ...change } : entry)));

  function choose(next: File | undefined) {
    if (!next) return;
    setRemovedFile(null);
    setFile(next);
    setUploadError(null);
    setSynthetic(false);
    setTried(false);
    setDetailsOpen(true);
    setFileError(fileProblem(next.name));
  }

  function removeAttachment() {
    if (busy || !file) return;
    setDetailsOpen(false);
    setRemovedFile(file);
    setUndoPaused(false);
    setFile(null);
    setFileError(null);
    setUploadError(null);
    setTried(false);
  }

  function drop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragging(false);
    if (canAttach && !busy) choose(event.dataTransfer.files[0]);
  }

  const busy = uploading;
  const text = input.trim();
  const chosen = patients?.find((p) => p.id === patientId);
  const chosenIncomplete = chosen ? incompleteness(chosen) === 'incomplete' : false;
  const blocked = file
    ? !chosen
      ? 'Choose the patient first.'
      : !synthetic
        ? 'Confirm the file is synthetic.'
        : fileError
    : !text
      ? canAttach
        ? 'Attach a report or ask a question.'
        : 'Type a question.'
      : null;

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
    if (file && !detailsOpen) {
      setDetailsOpen(true);
      return;
    }
    setTried(true);
    if (busy || sending.current || blocked) return;
    sending.current = true;
    try {
      setTried(false);
      if (file) {
        const patient = chosen;
        if (!patient) return;
        const reportType = reportTypeFor(file.name);
        const parsed = productUploadSchema.safeParse({ patientId: patient.id, reportType, file, syntheticConfirmed: synthetic });
        if (!parsed.success) {
          setFileError(parsed.error.issues[0]?.message ?? 'This file cannot be uploaded.');
          return;
        }
        setDetailsOpen(false);
        setUploadError(null);
        const id = ++counter.current;
        setEntries((list) => [
          ...list,
          { kind: 'upload', id, filename: file.name, patient: patient.label, patientId: patient.id, note: text || undefined, stage: 0, phase: 'uploading' },
        ]);
        setUploading(true);
        transfer.current = new AbortController();
        progress.current = {};
        const watch = window.setInterval(() => update(id, { stage: uploadStage(progress.current.attempt?.state) }), 150);
        let reportId: string;
        try {
          reportId = (await submitReport(parsed.data, apiFetch, progress.current, transfer.current.signal, recoverySession ?? undefined)).reference;
          update(id, { stage: UPLOAD_STEPS.length, phase: 'sent', reportId, status: 'received' });
          setFile(null);
          setDetailsOpen(false);
          setSynthetic(false);
        } catch (error) {
          if (error instanceof SessionEndedError) return;
          if (progress.current.cancelRequested) await cancelOwnedUpload(apiFetch, progress.current).catch(() => undefined);
          setDetailsOpen(true);
          const message = progress.current.cancelRequested
            ? 'Upload cancelled.'
            : error instanceof SubmitError
              ? error.message
              : 'The upload was interrupted. Your file is kept; please retry.';
          setUploadError(message);
          update(id, { phase: 'failed', message });
          return;
        } finally {
          window.clearInterval(watch);
          transfer.current = null;
          setUploading(false);
        }
        announceReportsChanged();
        void readStatus(id, reportId, patient.id, false);
        setInput('');
        return;
      }
      if (text) {
        setEntries((list) => [...list, { kind: 'question', id: ++counter.current, text }]);
        setInput('');
      }
    } finally {
      sending.current = false;
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
        if (!canAttach || busy) return;
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
        isLoading={busy}
        allowEmpty={!!file}
        className="border-0 bg-transparent p-0"
      >
        {file && !detailsOpen && (
          <Button variant="outline" size="sm" onClick={() => setDetailsOpen(true)} aria-label="Report details">
            <FileText aria-hidden="true" className="size-4" />
            <span className="truncate">{file.name}</span>
          </Button>
        )}
        {file && (
          <ContextDrawer
            id="chat-report-details"
            title="Report details"
            closeLabel="Close report details"
            className="report-intake"
            open={detailsOpen && active}
            onClose={() => {
              if (!busy) setDetailsOpen(false);
            }}
          >
            <div className="one-screen-file">
              <div className="flex items-center gap-2">
                <FileText aria-hidden="true" className="size-4 shrink-0" />
                <span className="min-w-0 flex-1 truncate font-medium">{file.name}</span>
                <Button variant="ghost" size="sm" className="size-11 shrink-0 p-0" aria-label="Remove file" disabled={busy} onClick={removeAttachment}>
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
                  disabled={busy}
                  error={patientsError}
                  onRetry={loadPatients}
                />
                {morePatients && !patientsError && (
                  <Button variant="ghost" size="sm" disabled={busy} pending={patientsLoading} pendingLabel="Loading patients…" onClick={loadPatients}>
                    More patients
                  </Button>
                )}
                {!busy && (
                  <Link to="/patients/new" className="inline-flex min-h-control items-center text-sm underline" onClick={() => setDetailsOpen(false)}>
                    Add patient
                  </Link>
                )}
              </div>
              <label htmlFor="chat-report-note" className="flex flex-col gap-1 text-sm">
                Note (optional)
                <Input id="chat-report-note" aria-label="Report note" value={input} maxLength={400} disabled={busy} onChange={(event) => setInput(event.target.value)} />
              </label>
              {/* Incomplete demographics remain visible without blocking report storage. */}
              {chosenIncomplete && <p className="text-warning">{INCOMPLETE_PROMPT}</p>}
              <label className="inline-flex min-h-11 items-center gap-2">
                <input type="checkbox" className="size-5 shrink-0 accent-primary" checked={synthetic} disabled={busy} onChange={(event) => setSynthetic(event.target.checked)} />
                {CONFIRMATION}
              </label>
              {(fileError || uploadError) && (
                <p role="alert" className="text-destructive">
                  {fileError ?? uploadError}
                </p>
              )}
              <p className="text-xs text-muted-foreground">Your report uploads after you confirm these details. Progress will appear in this chat.</p>
              <div className="flex justify-end gap-2">
                {uploading ? (
                  <Button variant="outline" onClick={stop}>
                    Stop upload
                  </Button>
                ) : (
                  <Button variant="outline" disabled={busy} onClick={() => setDetailsOpen(false)}>
                    Back to chat
                  </Button>
                )}
                <Button aria-label="Upload report" pending={busy} pendingLabel="Uploading…" aria-disabled={!!blocked} onClick={() => void send()}>
                  Upload report
                </Button>
              </div>
              {tried && blocked && (
                <p role="status" className="text-sm text-muted-foreground">
                  {blocked}
                </p>
              )}
            </div>
          </ContextDrawer>
        )}
        {removedFile && (
          <div
            role="status"
            className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground"
            onMouseEnter={() => setUndoPaused(true)}
            onMouseLeave={(event) => {
              if (!event.currentTarget.contains(document.activeElement)) setUndoPaused(false);
            }}
            onFocusCapture={() => setUndoPaused(true)}
            onBlurCapture={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget) && !event.currentTarget.matches(':hover')) setUndoPaused(false);
            }}
          >
            <span>Attachment removed.</span>
            <Button size="sm" variant="ghost" aria-label="Undo attachment removal" disabled={busy} onClick={() => choose(removedFile)}>
              Undo
            </Button>
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
                disabled={busy}
                accept={chatFileAccept()}
                hidden
                tabIndex={-1}
                aria-hidden="true"
                onChange={(event) => {
                  choose(event.target.files?.[0]);
                  event.target.value = '';
                }}
              />
              <Button variant="ghost" size="sm" className="size-11 rounded-full p-0" aria-label="Attach a report" disabled={busy} onClick={() => picker.current?.click()}>
                <Paperclip aria-hidden="true" className="size-5" />
              </Button>
            </>
          ) : (
            <span />
          )}
          {detailsOpen ? (
            <span />
          ) : uploading ? (
            <Button size="sm" className="size-11 rounded-full p-0" aria-label="Stop" onClick={stop}>
              <Square aria-hidden="true" className="size-4" />
            </Button>
          ) : (
            <Button size="sm" className="size-11 rounded-full p-0" aria-label="Send" aria-disabled={!!blocked} title={blocked ?? undefined} onClick={() => void send()}>
              <ArrowUp aria-hidden="true" className="size-5" />
            </Button>
          )}
        </div>
        {tried && blocked && !detailsOpen && (
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
            <p className="mb-2 text-center text-sm break-words text-muted-foreground">{preferredName ? `Welcome, ${preferredName}.` : 'Welcome.'}</p>
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
                  {entry.note && <p className="one-screen-you self-end rounded-2xl bg-surface px-4 py-2 break-words">{entry.note}</p>}
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
      {/* The expanded attachment form can exceed a mobile viewport; let it flow below the heading. */}
      <div className={`one-screen-column one-screen-dock bg-background pt-2 pb-3${file ? '' : ' sticky'}`}>
        {box}
        <div className="mt-3">
          <SystemMessage quiet>Synthetic data only. Not for clinical use.</SystemMessage>
        </div>
        {interrupted && (
          <p className="mt-2 text-center text-sm">
            An earlier upload was interrupted. <Link to="/reports/upload">Resume or cancel upload</Link>.
          </p>
        )}
      </div>
    </div>
  );
}
