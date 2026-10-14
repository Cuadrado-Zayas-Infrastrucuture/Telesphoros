// Adapted from Prompt Kit ScrollButton; caller owns scroll region and focus destination.
import { ArrowDown } from 'lucide-react';
import { Button } from '@/components/ui/Button';
export function ScrollButton({ onClick }: { onClick: () => void }) {
  return <Button size="sm" variant="outline" className="shadow-panel" onClick={onClick}><ArrowDown aria-hidden="true" className="size-4" />Latest message</Button>;
}
