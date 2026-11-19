import { Info } from 'lucide-react';
import { Tooltip } from '@/components/arc/Tooltip';
import { Button } from '@/components/ui/Button';

/**
 * An icon button that shows or hides a section's explanation (specs/041 D7): how-to text opens on demand, so the page leads with
 * actions. The caller renders the explanation with `id={controls}` while `open`. Safety statements never go behind one of these.
 * Its name shows in a tooltip on hover and on keyboard focus (specs/042 D6).
 */
export function InfoButton({ label, open, controls, onToggle }: { label: string; open: boolean; controls: string; onToggle: () => void }) {
  return (
    <Tooltip label={label}>
      <Button variant="ghost" size="sm" className="shrink-0 px-0" aria-label={label} aria-expanded={open} aria-controls={controls} onClick={onToggle}>
        <Info aria-hidden="true" className="size-4 shrink-0" />
      </Button>
    </Tooltip>
  );
}
