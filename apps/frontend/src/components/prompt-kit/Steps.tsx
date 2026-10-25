// Adapted from Prompt Kit steps / chain-of-thought visual structure; public process summaries only.
import { Check, Circle } from 'lucide-react';
const labels = ['Load example context', 'Check evidence availability', 'Prepare fixed response'];
export function Steps({ stage, failed = false }: { stage: number; failed?: boolean }) {
  return (
    <ol aria-label="Simulated process steps" className="ml-2 border-l border-divider pl-4">
      {labels.map((label, index) => (
        <li key={label} className="flex items-start gap-3 py-2 text-sm">
          <span aria-hidden="true" className="mt-1 shrink-0">
            {index < stage ? <Check className="size-4" /> : <Circle className="size-4" />}
          </span>
          <div>
            <p className="font-medium">{label}</p>
            <p className="text-xs text-muted-foreground">
              {index < stage ? 'Demonstrated' : failed && index === stage ? 'Simulated failure' : index === stage ? 'In progress · simulated' : 'Waiting'}
            </p>
          </div>
        </li>
      ))}
    </ol>
  );
}
