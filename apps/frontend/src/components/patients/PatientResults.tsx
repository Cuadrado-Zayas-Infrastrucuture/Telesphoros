import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import type { DecisionLink } from '@/lib/clinicianDecisions';
import { ResultsList } from './ResultsList';

export function PatientResults(props: { patientId: string; followupBusy: boolean; onFollowup: (link: DecisionLink) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <section aria-label="Recorded results" className="flex flex-col gap-4 border-t border-border pt-6">
      <h2 className="text-lg font-semibold">Results and decisions</h2>
      <Button variant="outline" className="self-start" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        Recorded results
      </Button>
      {open && <ResultsList {...props} />}
    </section>
  );
}
