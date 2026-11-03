import { Button } from '@/components/ui/Button';

/** "Attachment removed. Undo": stays while the pointer or focus is inside it, so the offer does not expire under a slow hand. */
export function RemovedAttachmentNotice({ busy, onUndo, onPause }: { busy: boolean; onUndo: () => void; onPause: (paused: boolean) => void }) {
  return (
    <div
      role="status"
      className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground"
      onMouseEnter={() => onPause(true)}
      onMouseLeave={(event) => {
        if (!event.currentTarget.contains(document.activeElement)) onPause(false);
      }}
      onFocusCapture={() => onPause(true)}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget) && !event.currentTarget.matches(':hover')) onPause(false);
      }}
    >
      <span>Attachment removed.</span>
      <Button size="sm" variant="ghost" aria-label="Undo attachment removal" disabled={busy} onClick={onUndo}>
        Undo
      </Button>
    </div>
  );
}
