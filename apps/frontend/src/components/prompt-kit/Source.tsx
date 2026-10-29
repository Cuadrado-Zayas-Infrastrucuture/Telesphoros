// Adapted from Prompt Kit Source; native disclosure is touch/keyboard accessible. No external favicons.
import { FileText } from 'lucide-react';
import { DEMO_SOURCE } from '@/lib/interpretationDemo';

const DEMO_DESCRIPTION = 'Hand-authored interface copy, not a clinical citation. No laboratory or guideline evidence supports this demonstration.';

/** With no `title`/`description` it is the chat preview's fixed demo source, unchanged. Callers must say plainly what the answer did NOT read. */
export function Source({ defaultOpen = false, title = DEMO_SOURCE, description = DEMO_DESCRIPTION }: { defaultOpen?: boolean; title?: string; description?: string }) {
  return (
    <details open={defaultOpen} className="border-t border-divider">
      <summary className="min-h-control cursor-pointer py-3 text-sm font-semibold">Response source</summary>
      <div className="mb-3 flex gap-3 rounded-md bg-background p-3 text-sm">
        <FileText aria-hidden="true" className="mt-1 size-5 shrink-0" />
        <div className="min-w-0">
          <p className="font-semibold wrap-anywhere">{title}</p>
          <p className="mt-1 text-muted-foreground">{description}</p>
        </div>
      </div>
    </details>
  );
}
