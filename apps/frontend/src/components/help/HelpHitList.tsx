import { Button } from '@/components/ui/Button';
import { hitKey } from '@/lib/helpConversation';
import type { HelpHit } from '@/lib/helpSearch';
import { hitTitle } from './HelpQuote';

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
