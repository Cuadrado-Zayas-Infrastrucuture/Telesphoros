// Adapted from Prompt Kit Tool: native disclosure replaces Collapsible; no raw payload dump.
import { Wrench } from 'lucide-react';
import { Steps } from './Steps';
export type ToolPart = { state: 'input-streaming' | 'input-available' | 'output-available' | 'output-error'; stage: number };
export function Tool({ toolPart, defaultOpen = false }: { toolPart: ToolPart; defaultOpen?: boolean }) {
  const failed = toolPart.state === 'output-error';
  const done = toolPart.state === 'output-available';
  return <details open={defaultOpen || undefined} className="rounded-md border border-divider bg-background"><summary className="min-h-control cursor-pointer px-3 py-3 text-sm"><span className="ml-2 inline-flex flex-wrap items-center gap-x-3 gap-y-1"><Wrench aria-hidden="true" className="size-4" /><span className="font-semibold">Example tool activity</span><span className={failed ? 'text-destructive' : 'text-muted-foreground'}>{failed ? 'Unavailable' : done ? 'Complete · simulated' : 'Running · simulated'}</span></span></summary><div className="border-t border-divider p-3"><p className="mb-2 text-xs text-muted-foreground">Local animation only. No tool, file parser or clinical engine was executed.</p><Steps stage={toolPart.stage} failed={failed} /></div></details>;
}
