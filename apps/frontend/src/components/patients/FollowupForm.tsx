import { ContentSkeleton } from '@/components/ui/ContentSkeleton';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { FollowupDto, FollowupInput, PatientMedicationDto } from '@telesphoros/shared-types';
import { useAuth } from '@/auth/AuthProvider';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Textarea } from '@/components/ui/Textarea';
import { readMedications } from '@/lib/patientMedications';
import { announceFollowupsChanged, readFollowupAssignees, recordFollowup } from '@/lib/patientFollowups';
import { SubmitError } from '@/lib/api';
import type { DecisionLink } from '@/lib/clinicianDecisions';
import { clinicianLabel } from '@/lib/clinicianLabel';
const selectClass = 'min-h-control w-full rounded-md border border-border bg-background px-3 py-2 text-base';
function localDate(offset = 0) {
  const date = new Date();
  date.setDate(date.getDate() + offset);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
export function FollowupForm({
  patientId,
  action,
  entry,
  decision,
  onClose,
  onSaved,
}: {
  patientId: string;
  action: FollowupInput['action'];
  entry?: FollowupDto;
  decision?: DecisionLink;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { apiFetch } = useAuth();
  const [context, setContext] = useState<{ medications: PatientMedicationDto[]; assignees: string[]; actor: string } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [loadError, setLoadError] = useState(false);
  const [medicationId, setMedicationId] = useState(entry?.medicationId ?? '');
  const [date, setDate] = useState(action === 'amend' ? (entry?.assessment?.date ?? localDate()) : localDate());
  const [assessmentTimezone] = useState(
    action === 'amend' ? (entry?.assessment?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone) : Intl.DateTimeFormat().resolvedOptions().timeZone,
  );
  const [response, setResponse] = useState<NonNullable<FollowupInput['assessment']>['response']>(
    action === 'amend' ? (entry?.assessment?.response ?? 'not-assessed') : 'not-assessed',
  );
  const [symptoms, setSymptoms] = useState<NonNullable<FollowupInput['assessment']>['symptoms']>(
    action === 'amend' ? (entry?.assessment?.symptoms ?? 'not-assessed') : 'not-assessed',
  );
  const [adherence, setAdherence] = useState<NonNullable<FollowupInput['assessment']>['adherence']>(
    action === 'amend' ? (entry?.assessment?.adherence ?? 'not-assessed') : 'not-assessed',
  );
  const [source, setSource] = useState<NonNullable<FollowupInput['assessment']>['source']>(
    action === 'amend' ? (entry?.assessment?.source ?? 'clinician-assessed') : 'clinician-assessed',
  );
  const [note, setNote] = useState(action === 'amend' && !entry?.noteRedacted ? (entry?.note ?? '') : '');
  const [nextChoice, setNextChoice] = useState(action === 'amend' ? (entry?.next ? 'date' : 'none') : action === 'schedule' || action === 'reschedule' ? 'date' : '');
  const [due, setDue] = useState(action === 'reschedule' || action === 'amend' ? (entry?.next?.date ?? '') : '');
  const [timezone, setTimezone] = useState(entry?.next?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone);
  const [assignee, setAssignee] = useState(entry?.next?.assignee ?? '');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const retry = useRef<{ body: string; id: string } | null>(null);
  const assessment = action === 'document' || action === 'amend';
  useEffect(() => {
    const controller = new AbortController();
    Promise.all([readMedications(apiFetch, patientId, controller.signal), readFollowupAssignees(apiFetch, controller.signal)])
      .then(([medications, people]) => {
        if (!controller.signal.aborted) {
          setContext({ medications, assignees: people.items, actor: people.currentActor });
          setLoadError(false);
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) setLoadError(true);
      });
    return () => controller.abort();
  }, [apiFetch, patientId, attempt]);
  async function save(event: FormEvent) {
    event.preventDefault();
    if (pending.current || !context) return;
    if (action !== 'dismiss' && !nextChoice) {
      setError('Choose a next follow-up date or no further follow-up.');
      return;
    }
    const values = {
      action,
      medicationId,
      decisionId: entry ? entry.decisionId : (decision?.id ?? null),
      ...(entry ? { threadId: entry.threadId, expectedVersion: entry.version } : {}),
      note,
      assessment: assessment ? { date, timezone: assessmentTimezone, response, symptoms, adherence, source } : null,
      next: action === 'dismiss' || nextChoice === 'none' ? null : { date: due, timezone, assignee: assignee || context.actor },
    };
    const body = JSON.stringify(values);
    if (retry.current?.body !== body) retry.current = { body, id: crypto.randomUUID() };
    pending.current = true;
    setBusy(true);
    setError(null);
    try {
      await recordFollowup(apiFetch, patientId, { ...values, requestId: retry.current.id });
      announceFollowupsChanged();
      onSaved();
    } catch (caught) {
      setError(caught instanceof SubmitError ? caught.message : 'Follow-up could not be saved. Your draft is kept.');
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  const title = { schedule: 'Schedule follow-up', document: 'Document follow-up', amend: 'Correct assessment', reschedule: 'Reschedule follow-up', dismiss: 'Dismiss reminder' }[
    action
  ];
  return (
    <form onSubmit={(event) => void save(event)} aria-label={title} className="flex flex-col gap-4 rounded-lg border border-border bg-panel p-4">
      <h3 className="font-medium">{title}</h3>
      {decision && <p className="text-sm wrap-anywhere">Linked decision: {decision.label}. Choose the recorded medication for this follow-up explicitly.</p>}
      {loadError ? (
        <div role="alert">
          Treatment or clinician details could not be loaded.{' '}
          <Button type="button" variant="outline" onClick={() => setAttempt((value) => value + 1)}>
            Retry details
          </Button>
        </div>
      ) : !context ? (
        <ContentSkeleton label="Loading treatment details…" variant="detail" />
      ) : (
        <>
          <fieldset disabled={busy} className="flex min-w-0 flex-col gap-4">
            <label className="flex flex-col gap-1 text-sm">
              Recorded medication
              <select className={selectClass} value={medicationId} required disabled={!!entry} onChange={(event) => setMedicationId(event.target.value)}>
                <option value="">Choose a medication</option>
                {entry && !context.medications.some((item) => item.id === entry.medicationId) && (
                  <option value={entry.medicationId}>{entry.medicationName} (recorded version)</option>
                )}
                {context.medications.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name} · {item.status}
                  </option>
                ))}
              </select>
            </label>
            {context.medications.length === 0 && !entry && <p className="text-sm">Add a recorded medication above before scheduling treatment follow-up.</p>}
            {assessment && (
              <>
                <label htmlFor="followup-assessment-date" className="flex flex-col gap-1 text-sm">
                  Assessment date
                  <Input
                    id="followup-assessment-date"
                    aria-describedby="assessment-timezone"
                    type="date"
                    required
                    value={date}
                    max={localDate()}
                    onChange={(event) => setDate(event.target.value)}
                  />
                </label>
                <p id="assessment-timezone" className="text-xs text-muted-foreground">
                  Assessment timezone: {assessmentTimezone}
                </p>
                <label className="flex flex-col gap-1 text-sm">
                  Treatment response
                  <select className={selectClass} value={response} onChange={(event) => setResponse(event.target.value as typeof response)}>
                    <option value="not-assessed">Not assessed</option>
                    <option value="improved">Improved</option>
                    <option value="unchanged">Unchanged</option>
                    <option value="worsened">Worsened</option>
                  </select>
                </label>
                <label className="flex flex-col gap-1 text-sm">
                  Adverse symptoms
                  <select className={selectClass} value={symptoms} onChange={(event) => setSymptoms(event.target.value as typeof symptoms)}>
                    <option value="not-assessed">Not assessed</option>
                    <option value="reported">Symptoms reported</option>
                    <option value="none-reported">No symptoms reported</option>
                  </select>
                </label>
                <details>
                  <summary className="flex min-h-control cursor-pointer items-center text-sm">Adherence and assessment source</summary>
                  <div className="flex flex-col gap-3 pt-2">
                    <label className="flex flex-col gap-1 text-sm">
                      Medication taking
                      <select className={selectClass} value={adherence} onChange={(event) => setAdherence(event.target.value as typeof adherence)}>
                        <option value="not-assessed">Not assessed</option>
                        <option value="taking-reported">Reported taking</option>
                        <option value="not-taking-reported">Reported not taking</option>
                      </select>
                    </label>
                    <label className="flex flex-col gap-1 text-sm">
                      Assessment source
                      <select className={selectClass} value={source} onChange={(event) => setSource(event.target.value as typeof source)}>
                        <option value="clinician-assessed">Clinician assessed</option>
                        <option value="patient-reported">Patient reported</option>
                      </select>
                    </label>
                  </div>
                </details>
              </>
            )}
            <label htmlFor="followup-note" className="flex flex-col gap-1 text-sm">
              {assessment ? 'Follow-up note' : 'Reason or treatment goal'}
              <Textarea id="followup-note" required maxLength={1000} rows={3} value={note} onChange={(event) => setNote(event.target.value)} />
            </label>
            {action !== 'dismiss' && (
              <fieldset disabled={action === 'amend'} className="flex min-w-0 flex-col gap-3">
                <legend className="mb-2 text-sm font-medium">Next follow-up</legend>
                {assessment && (
                  <label className="flex flex-col gap-1 text-sm">
                    Follow-up plan
                    <select required className={selectClass} value={nextChoice} onChange={(event) => setNextChoice(event.target.value)}>
                      <option value="">Choose a plan</option>
                      <option value="date">Schedule next follow-up</option>
                      <option value="none">No further follow-up needed</option>
                    </select>
                  </label>
                )}
                {nextChoice === 'date' && (
                  <>
                    <label htmlFor="followup-due-date" className="flex flex-col gap-1 text-sm">
                      Next follow-up date
                      <Input id="followup-due-date" type="date" required value={due} min={assessment ? date : undefined} onChange={(event) => setDue(event.target.value)} />
                    </label>
                    <div className="flex flex-wrap gap-2">
                      {[7, 14, 30].map((days) => (
                        <Button key={days} type="button" size="sm" variant="outline" onClick={() => setDue(localDate(days))}>
                          In {days} days
                        </Button>
                      ))}
                    </div>
                    <label className="flex flex-col gap-1 text-sm">
                      Responsible clinician
                      <select className={selectClass} value={assignee || context.actor} required onChange={(event) => setAssignee(event.target.value)}>
                        {context.assignees.map((person) => (
                          <option key={person} value={person}>
                            {clinicianLabel(person, context.actor)}
                          </option>
                        ))}
                        {assignee && !context.assignees.includes(assignee) && <option value={assignee}>Unavailable clinician — choose a replacement</option>}
                      </select>
                    </label>
                    <label htmlFor="followup-timezone" className="flex flex-col gap-1 text-sm">
                      Reminder timezone
                      <Input id="followup-timezone" required value={timezone} onChange={(event) => setTimezone(event.target.value)} />
                    </label>
                  </>
                )}
              </fieldset>
            )}
            {action === 'amend' && (
              <p className="text-sm text-muted-foreground">This correction keeps the existing reminder. Reschedule separately to change its date or clinician.</p>
            )}
          </fieldset>
        </>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" pending={busy} pendingLabel="Saving…" disabled={!context || loadError}>
          {action === 'document' || action === 'amend' ? 'Save follow-up' : title}
        </Button>
        <Button type="button" variant="outline" disabled={busy} onClick={onClose}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
