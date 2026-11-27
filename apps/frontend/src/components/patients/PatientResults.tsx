import type { DecisionLink } from '@/lib/clinicianDecisions';
import { RESULTS_WORDS } from '@/lib/words/patient';
import { useWords } from '@/lib/words/screens';
import { ResultsList } from './ResultsList';

/** The patient's stored results, read with the page: what is current and what can be done about it is not behind a click (specs/038 D4). */
export function PatientResults(props: { patientId: string; followupBusy: boolean; onFollowup: (link: DecisionLink) => void; initialResultId?: string | null }) {
  const words = useWords(RESULTS_WORDS);
  return (
    <section id="patient-results" aria-label={words.sectionLabel} className="flex flex-col gap-4 border-t border-border pt-6">
      <h2 className="text-lg font-semibold">{words.heading}</h2>
      <ResultsList {...props} />
    </section>
  );
}
