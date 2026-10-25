// Adapted from Prompt Kit ScrollButton; caller owns scroll region and focus destination.
import { ArrowDown } from 'lucide-react';
import { Button } from '@/components/ui/Button';
export function ScrollButton({ onClick, compact = false }: { onClick: () => void; compact?: boolean }) {
  return (
    <Button size="sm" variant="outline" className="shadow-panel" onClick={onClick}>
      <ArrowDown aria-hidden="true" className="size-4" />
      <span className={compact ? 'sr-only' : undefined}>Latest message</span>
    </Button>
  );
}
