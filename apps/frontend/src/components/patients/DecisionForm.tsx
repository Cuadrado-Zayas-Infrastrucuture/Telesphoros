import { useId, useRef, useState, type FormEvent } from 'react';
import {
  CDR_CHANGE_CODES,
  CDR_REASON_CODES,
  CDR_CODE_LABELS,
  clinicianDecisionCreateSchema,
  type CdrResponse,
  type CdrDetailCode,
  type ClinicianDecisionCreate,
  type ClinicianDecisionDto,
  type ClinicianDecisionHistoryDto,
} from '@telesphoros/shared-types';
import { useAuth } from '@/auth/AuthProvider';
import { Button } from '@/components/ui/Button';
import { Checkbox } from '@/components/ui/Checkbox';
import { Input } from '@/components/ui/Input';
import { Textarea } from '@/components/ui/Textarea';
import { DecisionUnconfirmed, decisionLabels, saveDecision } from '@/lib/clinicianDecisions';
import { SubmitError } from '@/lib/api';
import { usePatientLabel } from '@/lib/patientLabel';

export function DecisionForm({
  history,
  kind,
  initial,
  onCancel,
  onSaved,
  onStale,
  subject,
  followup,
}: {
  /** What the entry is about, in display words (the drug). The patient's label comes from the page. */
  subject?: string;
  /**
   * Whether a linked follow-up can be scheduled as a second step after a new decision (specs/038 D14): `offer` shows the optional choice,
   * `paused` says this environment records no follow-ups. Absent where the caller schedules none.
   */
  followup?: 'offer' | 'paused';
  history: ClinicianDecisionHistoryDto;
  kind: ClinicianDecisionCreate['entryKind'];
  initial?: ClinicianDecisionDto;
  onCancel: () => void;
  /** The decision is saved. `followup` is true when the clinician asked for the second step; `due` is the review-by date just recorded. */
  onSaved: (next: { followup: boolean; due: string | null }) => void;
  /** Called when the server refused the entry because the result or its history changed (409). */
  onStale: () => void;
}) {
  const { apiFetch } = useAuth();
  const patientLabel = usePatientLabel();
  const about = [patientLabel && `patient ${patientLabel}`, subject].filter(Boolean).join(' · ');
  const formId = useId();
  const [response, setResponse] = useState<CdrResponse | ''>(kind === 'amendment' ? (initial?.response ?? '') : '');
  const [codes, setCodes] = useState<CdrDetailCode[]>(kind === 'amendment' ? (initial?.detailCodes ?? []) : []);
  const [note, setNote] = useState('');
  const [reviewBy, setReviewBy] = useState(kind === 'amendment' ? (initial?.reviewBy ?? '') : '');
  const [thenFollowup, setThenFollowup] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [refused, setRefused] = useState(false);
  const pending = useRef(false);
  const request = useRef<ClinicianDecisionCreate | null>(null);
  const title = kind === 'decision' ? 'Record decision' : kind === 'amendment' ? 'Correct decision' : 'Withdraw entry';
  const visibleCodes = response === 'modified' ? [...CDR_CHANGE_CODES, ...CDR_REASON_CODES] : response && response !== 'accepted' ? [...CDR_REASON_CODES] : [];
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (pending.current || refused) return;
    if (!uncertain) {
      const checked = clinicianDecisionCreateSchema.safeParse({
        requestId: crypto.randomUUID(),
        evaluationId: history.evaluationId,
        patientId: history.patientId,
        entryKind: kind,
        previousEntryId: history.headEntryId,
        response: kind === 'entered-in-error' ? null : response || null,
        detailCodes: kind === 'entered-in-error' ? [] : codes,
        reviewBy: response === 'deferred' && kind !== 'entered-in-error' && reviewBy ? reviewBy : null,
        ...(note.trim() ? { note: note.trim() } : {}),
      });
      if (!checked.success) {
        setError(checked.error.issues[0]?.message ?? 'Check the decision fields.');
        return;
      }
      request.current = checked.data;
    }
    if (!request.current) return;
    pending.current = true;
    setBusy(true);
    setError('');
    try {
      const stored = await saveDecision(apiFetch, history.resultId, request.current);
      onSaved({ followup: kind === 'decision' && followup === 'offer' && thenFollowup, due: stored.reviewBy });
    } catch (caught) {
      setUncertain(caught instanceof DecisionUnconfirmed);
      setRefused(caught instanceof SubmitError && [403, 404, 409].includes(caught.status ?? 0));
      if (caught instanceof SubmitError && caught.status === 409) onStale();
      setError(caught instanceof Error ? caught.message : 'Decision could not be saved. Your draft is kept.');
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  return (
    <form aria-label={title} onSubmit={(event) => void submit(event)} className="flex flex-col gap-3 rounded-lg border border-border bg-panel p-4">
      <h4 className="font-medium">{title}</h4>
      {/* Who and what the entry is about, at the point it is confirmed (specs/038 D2). */}
      {about && <p className="text-sm wrap-anywhere">For {about}</p>}
      {kind === 'amendment' && (
        <p className="text-sm">
          Correct how the existing decision was documented. Use a new decision when the treatment plan changes. Earlier notes stay in history; enter a correction note below.
        </p>
      )}
      {kind === 'entered-in-error' && <p className="text-sm">Withdraw your latest entry as entered in error. The original remains in history.</p>}
      <fieldset disabled={busy || uncertain || refused} className="flex min-w-0 flex-col gap-3">
        {kind !== 'entered-in-error' && (
          <>
            <label className="flex flex-col gap-1 text-sm">
              Decision
              <select
                required
                className="min-h-control w-full rounded-md border border-border bg-background px-3"
                value={response}
                onChange={(event) => {
                  setResponse(event.target.value as CdrResponse);
                  setCodes([]);
                  setReviewBy('');
                }}
              >
                <option value="">Choose a decision</option>
                {Object.entries(decisionLabels).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            {visibleCodes.length > 0 && (
              <fieldset className="flex min-w-0 flex-col gap-1">
                <legend className="text-sm font-medium">Changes and reasons</legend>
                {visibleCodes.map((code) => (
                  <label key={code} className="flex min-h-control items-center gap-2 text-sm">
                    <Checkbox
                      checked={codes.includes(code)}
                      onChange={(event) => setCodes((values) => (event.target.checked ? [...values, code] : values.filter((value) => value !== code)))}
                    />
                    {CDR_CODE_LABELS[code]}
                  </label>
                ))}
              </fieldset>
            )}
            {response === 'deferred' && (
              <label htmlFor={`${formId}-review-by`} className="flex flex-col gap-1 text-sm">
                Review by (optional)
                <Input id={`${formId}-review-by`} type="date" value={reviewBy} onChange={(event) => setReviewBy(event.target.value)} />
                <span className="text-xs text-muted-foreground">This records the intended review date only. It creates no reminder: only a linked follow-up does.</span>
              </label>
            )}
          </>
        )}
        <label htmlFor={`${formId}-note`} className="flex flex-col gap-1 text-sm">
          Decision note
          <Textarea id={`${formId}-note`} rows={3} maxLength={1000} value={note} onChange={(event) => setNote(event.target.value)} />
        </label>
        {/* Optional, and a second step with its own save: the decision never waits on it (specs/038 D14). */}
        {kind === 'decision' && followup === 'offer' && (
          <div className="flex flex-col gap-1">
            <label htmlFor={`${formId}-followup`} className="flex min-h-control items-center gap-2 text-sm">
              <Checkbox id={`${formId}-followup`} checked={thenFollowup} onChange={(event) => setThenFollowup(event.target.checked)} />
              Then schedule a linked follow-up (optional)
            </label>
            <span className="text-xs text-muted-foreground">
              The decision is saved first. The follow-up is a second step with its own save, and it is what creates the in-app reminder.
            </span>
          </div>
        )}
        {kind === 'decision' && followup === 'paused' && (
          <p className="text-sm text-muted-foreground">Follow-up recording is not available in this environment, so no reminder can be created for this decision here.</p>
        )}
      </fieldset>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" pending={busy} pendingLabel="Saving…" disabled={refused}>
          {uncertain ? 'Retry save' : kind === 'entered-in-error' ? 'Confirm withdrawal' : 'Save decision'}
        </Button>
        <Button type="button" variant="outline" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
