// Adapted from Prompt Kit; no inferred model thoughts or latency claims.
import { Button } from '@/components/ui/Button';
import { Loader } from './Loader';
import { TextShimmer } from './TextShimmer';
export function ThinkingBar({ text, onStop }: { text: string; onStop: () => void }) {
  return <div className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-muted px-3 py-2"><div className="flex min-w-0 items-center gap-3 text-sm"><Loader /><TextShimmer>{text}</TextShimmer></div><Button variant="ghost" size="sm" onClick={onStop}>Stop preview</Button></div>;
}
