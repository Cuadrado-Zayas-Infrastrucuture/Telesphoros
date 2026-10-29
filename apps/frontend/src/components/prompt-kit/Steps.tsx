// Adapted from Prompt Kit steps / chain-of-thought visual structure; public process summaries only.
import { Check, Circle } from 'lucide-react';

const DEMO_LABELS = ['Load example context', 'Check evidence availability', 'Prepare fixed response'] as const;
const DEMO_WORDS = { done: 'Demonstrated', failed: 'Simulated failure', active: 'In progress · simulated', waiting: 'Waiting' };

/**
 * Process steps as words, never a badge. With no `labels` it is the chat preview's simulated process, unchanged; the one-screen workspace
 * (specs/021) passes the real upload's steps and words.
 */
export function Steps({
  stage,
  failed = false,
  labels = DEMO_LABELS,
  words = DEMO_WORDS,
  label = 'Simulated process steps',
  colored = false,
}: {
  /** Status as a word in color (success/failure). Off by default so the chat preview looks exactly as before. */
  colored?: boolean;
  stage: number;
  failed?: boolean;
  labels?: readonly string[];
  words?: { done: string; failed: string; active: string; waiting: string };
  label?: string;
}) {
  return (
    <ol aria-label={label} className="ml-2 border-l border-divider pl-4">
      {labels.map((step, index) => (
        <li key={step} className="flex items-start gap-3 py-2 text-sm">
          <span aria-hidden="true" className="mt-1 shrink-0">
            {index < stage ? <Check className="size-4" /> : <Circle className="size-4" />}
          </span>
          <div>
            <p className="font-medium">{step}</p>
            <p className={`text-xs ${colored && failed && index === stage ? 'text-destructive' : colored && index < stage ? 'text-success' : 'text-muted-foreground'}`}>
              {index < stage ? words.done : failed && index === stage ? words.failed : index === stage ? words.active : words.waiting}
            </p>
          </div>
        </li>
      ))}
    </ol>
  );
}
