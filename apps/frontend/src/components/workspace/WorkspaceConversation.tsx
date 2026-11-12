import { useEffect, useRef, useState, type DragEvent } from 'react';
import { Link } from 'react-router-dom';
import { ArrowUp, FileText, Paperclip, Square, X } from 'lucide-react';
import { SessionEndedError, useAuth } from '@/auth/AuthProvider';
import { CLINICAL_READ_ROLES, WRITER_ROLES } from '@/auth/roles';
import { PromptInput } from '@/components/prompt-kit/PromptInput';
import { PromptInputTextarea } from '@/components/prompt-kit/PromptInputTextarea';
import { SystemMessage } from '@/components/prompt-kit/SystemMessage';
import { PatientPicker } from '@/components/PatientPicker';
import { Input } from '@/components/ui/Input';
import { useRemovedAttachment } from '@/hooks/useRemovedAttachment';
import { useWorkspacePatients } from '@/hooks/useWorkspacePatients';
import { ConversationEntries, type Entry, type UploadEntry } from '@/components/workspace/ConversationEntries';
import { ConversationWelcome } from '@/components/workspace/ConversationWelcome';
import { RemovedAttachmentNotice } from '@/components/workspace/RemovedAttachmentNotice';
import { Button } from '@/components/ui/Button';
import { ContextDrawer } from '@/components/ui/ContextDrawer';
import { INCOMPLETE_PROMPT } from '@/components/patients/IncompleteWord';
import { incompleteness } from '@/lib/demographicsDraft';
import { SubmitError, submitReport, type UploadProgress } from '@/lib/api';
import { cancelOwnedUpload, getReport, removeUnfinishedReport, retireOwnedUpload } from '@/lib/ownedStorageApi';
import { productUploadSchema } from '@/lib/productUploadSchema';
import { reportTypeFor } from '@/lib/reportTypeFor';
import { readRecovery } from '@/lib/uploadRecovery';
import { UPLOAD_STEPS, uploadStage } from '@/lib/uploadSteps';
import { chatFileAccept, fileProblem } from '@/lib/workspaceFileRule';
import { announceReportsChanged, onPatientAdded } from '@/lib/workspaceEvents';
import '@/styles/one-screen.css';

const QUESTION_ID = 'workspace-question';
const CONFIRMATION = 'I confirm this file contains synthetic data only';
/** Said before anyone types (specs/038 D3): a typed question gets a note, never an answer (specs/024 D3). */
const NOT_ANSWERED = 'Typed questions are not answered here.';

/**
 * The chat home's conversation (specs/024): attach a synthetic report, choose its patient, confirm it is synthetic, send. The report appears with its status
 * word and a "Check status" action. A typed question gets a note, not an answer: there is no interpretation outside the local preview, and no request is made.
 * The box and the welcome say so before anyone types, and no patient is chosen until the clinician chooses one (specs/038 D2, D3).
 * The parent remounts this (a new key) for "New chat", which is how a conversation starts empty.
 */
export function WorkspaceConversation({ active = true }: { active?: boolean }) {
  const { roles, apiFetch, recoverySession, preferredName } = useAuth();
  const canAttach = roles.some((role) => WRITER_ROLES.includes(role));
  const { patients, loading: patientsLoading, error: patientsError, hasMore: morePatients, loadMore: loadPatients } = useWorkspacePatients(canAttach);
  const [file, setFile] = useState<File | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const attachment = useRemovedAttachment();
  // The patient is always the clinician's own choice (specs/038 D2): never the first one the list happened to load.
  const [patientId, setPatientId] = useState('');
  const [synthetic, setSynthetic] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [tried, setTried] = useState(false);
  const [input, setInput] = useState('');
  const [entries, setEntries] = useState<Entry[]>([]);
  const [uploading, setUploading] = useState(false);
  /** The conversation entry of the upload that just failed, while it can still be cancelled from the details. */
  const [failedId, setFailedId] = useState<number | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [interrupted] = useState(() => !!readRecovery(recoverySession));
  const counter = useRef(0);
  const picker = useRef<HTMLInputElement>(null);
  const transfer = useRef<AbortController | null>(null);
  const sending = useRef(false);
  const progress = useRef<UploadProgress>({});
  const progressWatch = useRef<number | undefined>(undefined);

  // Nested patient/panel navigation keeps this owner mounted. New chat (or leaving the workspace) ends it.
  // Stop local work without claiming cancellation on the server or discarding its scoped recovery record.
  useEffect(
    () => () => {
      retireOwnedUpload(progress.current);
      transfer.current?.abort();
      window.clearInterval(progressWatch.current);
    },
    [],
  );

  useEffect(() => onPatientAdded((patient) => setPatientId(patient.id)), []);

  const update = (id: number, change: Partial<UploadEntry>) =>
    setEntries((list) => list.map((entry) => (entry.id === id && entry.kind === 'upload' ? { ...entry, ...change } : entry)));

  function choose(next: File | undefined) {
    if (!next) return;
    attachment.discard();
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
    attachment.offer(file);
    setFile(null);
    setFileError(null);
    setUploadError(null);
    setTried(false);
  }

  /**
   * After a failed upload: the server cancels the attempt (aborting the browser request alone is not cancellation), then the report it registered, which never
   * got its file, is removed so it does not stay in Past reports. Nothing is removed unless the server acknowledged the cancel.
   */
  async function cancelFailed() {
    if (busy || cancelling || failedId === null) return;
    const pending = progress.current;
    setCancelling(true);
    try {
      await cancelOwnedUpload(apiFetch, pending);
      if (pending.reportId) await removeUnfinishedReport(apiFetch, pending.reportId);
    } catch (error) {
      if (!(error instanceof SessionEndedError)) setUploadError(error instanceof SubmitError ? error.message : 'The upload could not be cancelled. Please retry.');
      return;
    } finally {
      setCancelling(false);
    }
    update(failedId, { message: 'Upload cancelled and removed from your reports.' });
    progress.current = {};
    setFailedId(null);
    setDetailsOpen(false);
    setFile(null);
    setFileError(null);
    setUploadError(null);
    setSynthetic(false);
    setTried(false);
    announceReportsChanged();
  }

  function drop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragging(false);
    if (canAttach && !busy) choose(event.dataTransfer.files[0]);
  }

  const busy = uploading || cancelling;
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
        ? 'Attach a report to upload it.'
        : 'Nothing to send yet.'
      : null;

  /** Read the known report directly: a patient's history can span many pages or a merged group. */
  async function readStatus(id: number, reportId: string, announce: boolean) {
    update(id, { checking: true, checkNote: undefined });
    try {
      const report = await getReport(apiFetch, reportId);
      update(id, { status: report.status, checking: false });
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
        setFailedId(null);
        const id = ++counter.current;
        setEntries((list) => [
          ...list,
          { kind: 'upload', id, filename: file.name, patient: patient.label, patientId: patient.id, note: text || undefined, stage: 0, phase: 'uploading' },
        ]);
        setUploading(true);
        transfer.current = new AbortController();
        // Keep registration and attempt identities until success or acknowledged cancellation, including after a lost reply.
        const watch = window.setInterval(() => update(id, { stage: uploadStage(progress.current.attempt?.state) }), 150);
        progressWatch.current = watch;
        let reportId: string;
        try {
          reportId = (await submitReport(parsed.data, apiFetch, progress.current, transfer.current.signal, recoverySession ?? undefined)).reference;
          progress.current = {};
          update(id, { stage: UPLOAD_STEPS.length, phase: 'sent', reportId, status: 'received' });
          setFile(null);
          setDetailsOpen(false);
          setSynthetic(false);
        } catch (error) {
          if (error instanceof SessionEndedError) return;
          let message = error instanceof SubmitError ? error.message : 'The upload was interrupted. Your file is kept; please retry.';
          if (progress.current.cancelRequested) {
            try {
              await cancelOwnedUpload(apiFetch, progress.current);
              message = 'Upload cancelled.';
            } catch (cancelError) {
              if (cancelError instanceof SessionEndedError) return;
              message = cancelError instanceof SubmitError ? cancelError.message : 'Cancellation could not be confirmed. Retry cancellation before starting over.';
            }
          }
          setDetailsOpen(true);
          setUploadError(message);
          update(id, { phase: 'failed', message });
          setFailedId(id);
          announceReportsChanged();
          return;
        } finally {
          window.clearInterval(watch);
          progressWatch.current = undefined;
          transfer.current = null;
          setUploading(false);
        }
        announceReportsChanged();
        void readStatus(id, reportId, false);
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
          <span className="inline-flex max-w-full items-center gap-1">
            <Button variant="outline" size="sm" className="min-w-0" onClick={() => setDetailsOpen(true)} aria-label="Report details">
              <FileText aria-hidden="true" className="size-4" />
              <span className="truncate">{file.name}</span>
            </Button>
            <Button variant="ghost" size="sm" className="size-11 shrink-0 p-0" aria-label={`Remove ${file.name}`} disabled={busy} onClick={removeAttachment}>
              <X aria-hidden="true" className="size-4" />
            </Button>
          </span>
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
              {/* The identity is repeated at the point of confirmation (specs/038 D2). */}
              <p className="text-sm">{chosen ? `This report will be stored for ${chosen.label}.` : 'No patient is chosen yet.'}</p>
              <p className="text-xs text-muted-foreground">Your report uploads after you confirm these details. Progress will appear in this chat.</p>
              <div className="flex justify-end gap-2">
                {uploading ? (
                  <Button variant="outline" onClick={stop}>
                    Stop upload
                  </Button>
                ) : (
                  <>
                    {failedId !== null && (
                      <Button variant="ghost" pending={cancelling} pendingLabel="Cancelling…" onClick={() => void cancelFailed()}>
                        Cancel upload
                      </Button>
                    )}
                    <Button variant="outline" disabled={busy || cancelling} onClick={() => setDetailsOpen(false)}>
                      Back to chat
                    </Button>
                  </>
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
        {attachment.removed && <RemovedAttachmentNotice busy={busy} onUndo={() => choose(attachment.removed!)} onPause={attachment.pause} />}
        <PromptInputTextarea
          id={QUESTION_ID}
          rows={2}
          maxLength={400}
          aria-label="Question"
          placeholder={file ? 'Add a note (optional)' : canAttach ? `Attach a report. ${NOT_ANSWERED}` : NOT_ANSWERED}
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
          <ConversationWelcome preferredName={preferredName} canAttach={canAttach} canReadRecords={roles.some((role) => CLINICAL_READ_ROLES.includes(role))} />
        ) : (
          <ConversationEntries entries={entries} onCheckStatus={(entry) => void readStatus(entry.id, entry.reportId!, true)} />
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
