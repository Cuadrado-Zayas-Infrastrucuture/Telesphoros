import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { History, Plus } from 'lucide-react';
import productMark from '@/assets/telesphoros-shield-rx.png';
import { useAuth } from '@/auth/AuthProvider';
import { ADMIN_ROLES, primaryRole } from '@/auth/roles';
import { Button } from '@/components/ui/Button';

/** The only chrome on the one-screen workspace: the mark, then New, Past reports and the account (specs/016 D2, D8). */
export function WorkspaceBar({ onNew, onHistory }: { onNew: () => void; onHistory: () => void }) {
  const { roles, signOut } = useAuth();
  const [open, setOpen] = useState(false);
  const toggle = useRef<HTMLButtonElement>(null);
  const role = primaryRole(roles) ?? 'no role';
  const links = [...(roles.some((r) => ADMIN_ROLES.includes(r)) ? [{ to: '/usage', label: 'Usage' }] : []), { to: '/settings', label: 'Settings' }, { to: '/', label: 'Overview' }];
  useEffect(() => {
    if (!open) return;
    const dismiss = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setOpen(false);
      toggle.current?.focus();
    };
    document.addEventListener('keydown', dismiss);
    return () => document.removeEventListener('keydown', dismiss);
  }, [open]);
  return (
    <header className="flex items-center justify-between gap-3 px-4 py-3 sm:px-5">
      <Link to="/" className="inline-flex items-center gap-2 rounded-sm font-heading font-semibold">
        <img src={productMark} alt="" width="64" height="66" loading="eager" className="one-screen-mark" />
        Telesphoros
      </Link>
      <div className="flex items-center gap-1">
        <Button variant="ghost" size="sm" className="size-11 rounded-full p-0" aria-label="New interpretation" title="New interpretation" onClick={onNew}>
          <Plus aria-hidden="true" className="size-5" />
        </Button>
        <Button variant="ghost" size="sm" className="size-11 rounded-full p-0" aria-label="Past reports" title="Past reports" onClick={onHistory}>
          <History aria-hidden="true" className="size-5" />
        </Button>
        <div className="relative">
          <Button
            ref={toggle}
            variant="ghost"
            size="sm"
            className="size-11 rounded-full p-0"
            aria-label={`Account, ${role}`}
            aria-expanded={open}
            aria-controls="one-screen-account"
            onClick={() => setOpen((current) => !current)}
          >
            <span aria-hidden="true" className="grid size-8 place-items-center rounded-full bg-muted text-sm font-semibold">
              {role.charAt(0).toUpperCase()}
            </span>
          </Button>
          <div id="one-screen-account" hidden={!open} className="absolute right-0 z-10 mt-2 w-56 rounded-md border border-divider bg-panel p-1 shadow-panel">
            <p className="px-3 py-2 text-xs text-muted-foreground">
              Signed in as <strong className="text-foreground">{role}</strong>
            </p>
            <ul>
              {links.map(({ to, label }) => (
                <li key={to}>
                  <Link to={to} className="flex min-h-11 items-center rounded-sm px-3 text-sm hover:bg-muted">
                    {label}
                  </Link>
                </li>
              ))}
              <li className="mt-1 border-t border-divider pt-1">
                <button type="button" className="flex min-h-11 w-full items-center rounded-sm px-3 text-left text-sm hover:bg-muted" onClick={() => void signOut()}>
                  Sign out
                </button>
              </li>
            </ul>
          </div>
        </div>
      </div>
    </header>
  );
}
