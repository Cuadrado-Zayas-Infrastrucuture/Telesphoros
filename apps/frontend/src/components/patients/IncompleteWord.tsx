import type { PatientDto } from '@telesphoros/shared-types';
import { incompleteness } from '@/lib/demographicsDraft';
import { cn } from '@/lib/utils';

/** Spec 025 D9 / T302: "Incomplete" as a word in color, never a badge, for a patient whose demographics are missing. Renders nothing otherwise. */
export function IncompleteWord({ patient, className }: { patient: Pick<PatientDto, 'demographicsComplete'>; className?: string }) {
  if (incompleteness(patient) !== 'incomplete') return null;
  return <span className={cn('text-warning', className)}>Incomplete</span>;
}

/** The one line shown when a report is attached to an Incomplete patient. It never blocks the upload. */
export const INCOMPLETE_PROMPT = "This patient's demographics are incomplete. You can still attach the report; add them on the patient's page.";
