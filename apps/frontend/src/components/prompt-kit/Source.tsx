// Adapted from Prompt Kit Source; native disclosure is touch/keyboard accessible. No external favicons.
import { FileText } from 'lucide-react';
import { DEMO_SOURCE } from '@/lib/interpretationDemo';
export function Source() {
  return <details className="border-t border-divider"><summary className="min-h-control cursor-pointer py-3 text-sm font-semibold">Response source</summary><div className="mb-3 flex gap-3 rounded-md bg-background p-3 text-sm"><FileText aria-hidden="true" className="mt-1 size-5 shrink-0" /><div className="min-w-0"><p className="font-semibold">{DEMO_SOURCE}</p><p className="mt-1 text-muted-foreground">Hand-authored interface copy, not a clinical citation. No laboratory or guideline evidence supports this demonstration.</p></div></div></details>;
}
