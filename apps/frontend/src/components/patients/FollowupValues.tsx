import type { FollowupDto } from '@telesphoros/shared-types';
import { clinicianLabel } from '@/lib/clinicianLabel';

/** `actor` is the signed-in clinician's id, when the caller knows it, so their own entries read "Me". */
export function FollowupValues({ entry, actor }: { entry: FollowupDto; actor?: string }) {
  return (
    <div className="flex flex-col gap-1 text-sm">
      {entry.assessment && (
        <p>
          {entry.assessment.date} · {entry.assessment.response === 'not-assessed' ? 'Response not assessed' : `Response: ${entry.assessment.response}`} ·{' '}
          {entry.assessment.source === 'patient-reported' ? 'Patient reported' : 'Clinician assessed'}
        </p>
      )}
      {entry.assessment && (
        <p className="text-muted-foreground">
          Symptoms: {entry.assessment.symptoms.replaceAll('-', ' ')} · Medication taking: {entry.assessment.adherence.replaceAll('-', ' ')}
        </p>
      )}
      <p className="whitespace-pre-wrap wrap-anywhere">{entry.noteRedacted ? 'Note redacted.' : entry.note}</p>
      <p className="text-xs text-muted-foreground">
        Recorded {new Date(entry.createdAt).toLocaleString()} · {clinicianLabel(entry.createdBy, actor)}
      </p>
    </div>
  );
}
