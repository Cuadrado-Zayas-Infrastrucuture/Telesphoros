// Adapted from Prompt Kit; no inferred model thoughts or latency claims.
import { Button } from '@/components/ui/Button';
import { Loader } from './Loader';
import { TextShimmer } from './TextShimmer';
export function ThinkingBar({ text, stage, onStop }: { text: string; stage: number; onStop: () => void }) {
  return <div role="group" aria-label="Sample response preparation" className="preview-thinking rounded-md border border-divider px-4 py-3"><div className="flex flex-wrap items-center justify-between gap-2"><div className="flex min-w-0 items-center gap-3 text-sm"><Loader /><TextShimmer>{text}</TextShimmer></div><Button variant="ghost" size="sm" onClick={onStop}>Stop preview</Button></div><div className="mt-2 flex gap-1" aria-hidden="true">{[0, 1, 2].map(step => <span key={step} className={`h-1 flex-1 rounded-sm ${step <= stage ? 'bg-primary' : 'bg-divider'}`} />)}</div><p className="mt-2 text-xs text-muted-foreground">Simulated preparation · phase {stage + 1} of 3</p></div>;
}
