// Adapted from Prompt Kit FeedbackBar; 44px controls, persistent labels, local state only.
import { ThumbsDown, ThumbsUp } from 'lucide-react';
import { Button } from '@/components/ui/Button';
export function FeedbackBar({ value, onChange }: { value: 'helpful' | 'not-helpful' | null; onChange: (value: 'helpful' | 'not-helpful' | null) => void }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-3 border-t border-divider pt-2">
      <p className="text-xs text-muted-foreground">{value ? 'Feedback marked locally · not submitted' : 'Was this layout helpful?'}</p>
      <div className="flex gap-1">
        <Button
          size="sm"
          variant="ghost"
          aria-label="Helpful"
          aria-pressed={value === 'helpful'}
          className="aria-pressed:bg-muted"
          onClick={() => onChange(value === 'helpful' ? null : 'helpful')}
        >
          <ThumbsUp aria-hidden="true" className="size-4" />
          <span className="sr-only">Helpful</span>
        </Button>
        <Button
          size="sm"
          variant="ghost"
          aria-label="Not helpful"
          aria-pressed={value === 'not-helpful'}
          className="aria-pressed:bg-muted"
          onClick={() => onChange(value === 'not-helpful' ? null : 'not-helpful')}
        >
          <ThumbsDown aria-hidden="true" className="size-4" />
          <span className="sr-only">Not helpful</span>
        </Button>
      </div>
    </div>
  );
}
