import { ArrowUpRight, FileText } from 'lucide-react';
import { Button } from '@/components/ui/Button';

/** A source shortcut opens the local evidence drawer; the fixture has no external citation URL. */
export function SourceTrigger({ onClick }: { onClick: () => void }) {
  return (
    <Button variant="ghost" size="sm" aria-label="View response evidence" onClick={onClick}>
      <FileText aria-hidden="true" className="size-4" />1 demo source
      <ArrowUpRight aria-hidden="true" className="size-3" />
    </Button>
  );
}
