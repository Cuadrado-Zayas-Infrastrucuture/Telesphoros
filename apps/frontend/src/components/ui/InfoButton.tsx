import { Info } from 'lucide-react';
import { Button } from '@/components/ui/Button';

/**
 * An icon button that shows or hides a section's explanation (specs/041 D7): how-to text opens on demand, so the page leads with
 * actions. The caller renders the explanation with `id={controls}` while `open`. Safety statements never go behind one of these.
 */
export function InfoButton({ label, open, controls, onToggle }: { label: string; open: boolean; controls: string; onToggle: () => void }) {
  return (
    <Button variant="ghost" size="sm" className="shrink-0 px-0" aria-label={label} title={label} aria-expanded={open} aria-controls={controls} onClick={onToggle}>
      <Info aria-hidden="true" className="size-4 shrink-0" />
    </Button>
  );
}
