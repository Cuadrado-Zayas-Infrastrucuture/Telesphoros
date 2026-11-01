import { useEffect, useRef, type ReactNode, type RefObject } from 'react';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/Button';

/** Native modal semantics keep the background inert and support Escape and nested image dialogs. */
export function ContextDrawer({
  open,
  onClose,
  title,
  id,
  children,
  headingRef,
  closeLabel,
  className,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  id: string;
  children: ReactNode;
  closeLabel?: string;
  className?: string;
  headingRef?: RefObject<HTMLHeadingElement | null>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const localHeading = useRef<HTMLHeadingElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const heading = headingRef ?? localHeading;
  useEffect(() => {
    const panel = dialog.current;
    if (!panel) return;
    if (open && !panel.open) {
      returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      panel.showModal();
      heading.current?.focus();
    } else if (!open && panel.open) {
      panel.close();
      if (returnFocus.current?.isConnected) returnFocus.current.focus();
    }
  }, [open, heading]);
  return (
    <dialog
      ref={dialog}
      id={id}
      aria-modal="true"
      aria-labelledby={`${id}-heading`}
      onCancel={(event) => {
        if (event.target === event.currentTarget) {
          event.preventDefault();
          onClose();
        }
      }}
      // A queued close event from a previous opening must not dismiss a newly reopened drawer.
      onClose={(event) => {
        if (event.target === event.currentTarget && !event.currentTarget.open) onClose();
      }}
      onKeyDown={(event) => {
        if (event.key !== 'Tab') return;
        if (event.target instanceof HTMLElement && event.target.closest('dialog') !== event.currentTarget) return;
        const controls = [...event.currentTarget.querySelectorAll<HTMLElement>('*')].filter(
          (element) => element.tabIndex >= 0 && !element.matches(':disabled') && element.getClientRects().length > 0,
        );
        const first = controls[0],
          last = controls.at(-1);
        if (!event.shiftKey && document.activeElement === last && first) {
          event.preventDefault();
          first.focus();
        }
        if (event.shiftKey && (document.activeElement === first || document.activeElement === heading.current) && last) {
          event.preventDefault();
          last.focus();
        }
      }}
      className={cn('context-drawer', className)}
    >
      <div className="flex items-center justify-between gap-3 border-b border-divider px-5 py-4">
        <h2 id={`${id}-heading`} ref={heading} tabIndex={-1} className="text-xl">
          {title}
        </h2>
        <Button variant="ghost" size="sm" aria-label={closeLabel ?? `Close ${title.toLowerCase()}`} onClick={onClose}>
          <X aria-hidden="true" className="size-5" />
        </Button>
      </div>
      <div className="context-drawer-body">{children}</div>
    </dialog>
  );
}
