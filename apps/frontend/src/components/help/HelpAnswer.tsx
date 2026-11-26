import { Link } from 'react-router-dom';
import { HELP_EN } from '@telesphoros/help-content';
import { Button } from '@/components/ui/Button';
import { hitKey, type HelpAnswer as Answer } from '@/lib/helpConversation';
import type { HelpHit } from '@/lib/helpSearch';
import { HELP_WORDS } from '@/lib/helpWords';
import { HelpQuote, hitTitle } from './HelpQuote';

/** A list of articles and words to open next, each a button that adds its answer to the conversation (plan C1-D1). */
export function HelpHitList({ hits, labelledBy, onOpen }: { hits: readonly HelpHit[]; labelledBy?: string; onOpen: (hit: HelpHit) => void }) {
  return (
    <ul aria-labelledby={labelledBy} className="flex flex-col gap-1">
      {hits.map((hit) => (
        <li key={hitKey(hit)}>
          <Button variant="ghost" className="min-h-control w-full justify-start text-left whitespace-normal" onClick={() => onOpen(hit)}>
            {hitTitle(hit)}
          </Button>
        </li>
      ))}
    </ul>
  );
}

/**
 * Spec 053 slice C1: Help's side of one exchange. The refusal for a question about a patient, an article or word quoted whole with up to two
 * more under it, or the closest three when nothing answers exactly (plan section 2). It draws an answer `answerFor` has already decided.
 */
export function HelpAnswer({ answer, id, onOpen, onLeave }: { answer: Answer; id: string; onOpen: (hit: HelpHit) => void; onLeave: () => void }) {
  if (answer.kind === 'refusal') {
    return (
      <div className="flex flex-col gap-2">
        <p>{HELP_EN.refusal?.body ?? HELP_WORDS.refusalFallback}</p>
        {answer.patientLink && (
          <Link to={answer.patientLink} onClick={onLeave} className="inline-flex min-h-control items-center font-medium underline underline-offset-2">
            {HELP_WORDS.patientResults}
          </Link>
        )}
      </div>
    );
  }
  if (answer.kind === 'closest') {
    return (
      <div className="flex flex-col gap-2">
        <p id={`${id}-closest`}>{HELP_WORDS.weak}</p>
        {answer.hits.length > 0 ? <HelpHitList hits={answer.hits} labelledBy={`${id}-closest`} onOpen={onOpen} /> : <p>{HELP_WORDS.tryOther}</p>}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-3">
      <HelpQuote hit={answer.hit} headingId={`${id}-heading`} onLeave={onLeave} />
      {answer.more.length > 0 && (
        <div className="flex flex-col gap-1">
          <p id={`${id}-more`} className="text-sm font-medium">
            {HELP_WORDS.alsoInHelp}
          </p>
          <HelpHitList hits={answer.more} labelledBy={`${id}-more`} onOpen={onOpen} />
        </div>
      )}
    </div>
  );
}
