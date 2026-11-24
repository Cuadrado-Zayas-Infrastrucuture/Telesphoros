import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/Button';
import { DECISION_WORDS } from '@/lib/genomicProfileWords';
import { syntheticStagingMode } from '@/lib/storageMode';

/**
 * Spec 044 D9 and slice B part 2 (B2-D4): "Record a decision" under a result's evidence. Where decisions are on, it is a link to this result
 * in the patient's results list (`?result=`), where the decision form spec 006 tested already is: a decision is recorded in one place only.
 * In the synthetic staging, where they are not, it is a disabled button with its sentence beside it in plain text, never only in a tooltip
 * (a disabled control's tooltip cannot be reached by keyboard). Nothing is written from the profile.
 */
export function GenomicDecisionControl({ resultId }: { resultId: string }) {
  if (syntheticStagingMode()) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" size="sm" disabled>
          {DECISION_WORDS.record}
        </Button>
        <p className="text-sm text-muted-foreground">{DECISION_WORDS.off}</p>
      </div>
    );
  }
  return (
    <div>
      <Button asChild variant="outline" size="sm">
        <Link to={{ search: `?result=${encodeURIComponent(resultId)}` }} onClick={showResults}>
          {DECISION_WORDS.recordHere}
        </Link>
      </Button>
    </div>
  );
}

// The results list opens the named result when it is read again; bring it into view.
function showResults() {
  requestAnimationFrame(() => document.getElementById('patient-results')?.scrollIntoView?.({ block: 'start' }));
}
