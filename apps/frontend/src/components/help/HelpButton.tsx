import { lazy, Suspense, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { useLocation } from 'react-router-dom';
import { CircleHelp } from 'lucide-react';
import { useAuth } from '@/auth/AuthProvider';
import { LazyTooltip } from '@/components/arc/LazyTooltip';
import { HELP_WORDS } from '@/lib/helpWords';
import { cn } from '@/lib/utils';

// The panel and its articles load the first time Help is opened, so the sidebar, which every page loads first, stays small.
const HelpPanel = lazy(() => import('./HelpPanel').then((module) => ({ default: module.HelpPanel })));

/**
 * Spec 051 slice H2 (H-D4): the sidebar's Help, on every signed-in page. It opens the help panel in the side drawer; Escape or the close
 * button closes it and returns the focus here. The panel stays mounted once loaded, so it opens again at once and closes the same way. It is
 * rendered into the page's body, not the sidebar: on a phone the sidebar is a menu that hides itself, and a dialog inside it would not show.
 */
export function HelpButton({ iconsOnly, onKeyDown }: { iconsOnly: boolean; onKeyDown: (event: KeyboardEvent<HTMLElement>) => void }) {
  const { roles } = useAuth();
  const { pathname } = useLocation();
  const [open, setOpen] = useState(false);
  const [loaded, setLoaded] = useState(false);
  return (
    <>
      <LazyTooltip label={iconsOnly ? HELP_WORDS.button : undefined} side="right">
        <button
          type="button"
          onKeyDown={onKeyDown}
          aria-haspopup="dialog"
          onClick={() => {
            setLoaded(true);
            setOpen(true);
          }}
          className={cn(
            'flex min-h-control w-full items-center gap-3 rounded-md px-3 py-2 text-left text-sm font-medium text-muted-foreground hover:bg-muted',
            open && 'bg-muted text-primary',
          )}
        >
          <CircleHelp aria-hidden="true" className="size-4 shrink-0" />
          <span className="workspace-link-label">{HELP_WORDS.button}</span>
        </button>
      </LazyTooltip>
      {loaded &&
        createPortal(
          <Suspense fallback={null}>
            <HelpPanel open={open} onClose={() => setOpen(false)} pathname={pathname} roles={roles} />
          </Suspense>,
          document.body,
        )}
    </>
  );
}
