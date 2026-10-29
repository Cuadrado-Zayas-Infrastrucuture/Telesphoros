import { useRef, useState, type KeyboardEvent } from 'react';
import { NavLink } from 'react-router-dom';
import { ChartColumn, FileText, Home, Menu, MessageSquare, Settings, Upload, X } from 'lucide-react';
import productMark from '@/assets/telesphoros-shield-rx.png';
import { useAuth } from '@/auth/AuthProvider';
import { ADMIN_ROLES, CLINICAL_READ_ROLES, WRITER_ROLES } from '@/auth/roles';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/Button';
import { AccountMenu } from './AccountMenu';

export function WorkspaceSidebar() {
  const { status, roles } = useAuth();
  const [open, setOpen] = useState(false);
  const toggle = useRef<HTMLButtonElement>(null);
  const links = [
    ...(import.meta.env.DEV && location.hostname === '127.0.0.1' ? [{ to: '/local-interpretation', label: 'Chat preview', icon: MessageSquare, show: true }] : []),
    { to: '/reports', label: 'Reports', icon: FileText, show: roles.some((role) => CLINICAL_READ_ROLES.includes(role)) },
    { to: '/reports/upload', label: 'Upload report', icon: Upload, show: roles.some((role) => WRITER_ROLES.includes(role)) },
    { to: '/usage', label: 'Usage', icon: ChartColumn, show: roles.some((role) => ADMIN_ROLES.includes(role)) },
    { to: '/settings', label: 'Settings', icon: Settings, show: status === 'signedIn' },
    { to: '/', label: 'Overview', icon: Home, show: true },
  ].filter((link) => link.show);
  function dismiss(event: KeyboardEvent<HTMLElement>) {
    if (event.key === 'Escape' && open) {
      setOpen(false);
      toggle.current?.focus();
    }
  }
  return (
    <header className="workspace-navigation">
      <div className="workspace-brand-row">
        <NavLink to="/" onClick={() => setOpen(false)} className="workspace-brand inline-flex min-w-0 items-center gap-2 rounded-sm">
          <img src={productMark} alt="Telesphoros shield and Rx logo" width="64" height="66" loading="eager" className="brand-mark h-auto w-16 shrink-0" />
          <span className="min-w-0">
            <span className="font-heading text-xl font-semibold tracking-tight">Telesphoros</span>
            <span className="block text-xs text-muted-foreground">by Cuadrado Zayas Infrastructure</span>
          </span>
        </NavLink>
        <Button
          onKeyDown={dismiss}
          ref={toggle}
          variant="ghost"
          size="sm"
          aria-label="Workspace navigation"
          aria-expanded={open}
          aria-controls="workspace-navigation-content"
          className="workspace-menu-toggle"
          onClick={() => setOpen((current) => !current)}
        >
          {open ? <X aria-hidden="true" className="size-5" /> : <Menu aria-hidden="true" className="size-5" />}
        </Button>
      </div>
      <div id="workspace-navigation-content" className={cn('workspace-navigation-content', open && 'is-open')}>
        <nav aria-label="Primary">
          <p className="mb-3 px-3 text-xs font-medium text-muted-foreground">Workspace</p>
          <ul className="flex flex-col gap-1">
            {links.map(({ to, label, icon: Icon }) => (
              <li key={to}>
                <NavLink
                  to={to}
                  end
                  onKeyDown={dismiss}
                  onClick={() => setOpen(false)}
                  className={({ isActive }) =>
                    cn(
                      'flex min-h-control items-center gap-3 rounded-md px-3 py-2 text-sm font-medium hover:bg-muted',
                      isActive ? 'bg-muted text-primary' : 'text-muted-foreground',
                    )
                  }
                >
                  <Icon aria-hidden="true" className="size-4 shrink-0" />
                  {label}
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>
        <div className="workspace-account border-t border-divider pt-4">
          <p className="mb-4 text-xs text-muted-foreground">
            Synthetic environment.
            <br />
            Clinical use not approved.
          </p>
          <AccountMenu />
        </div>
      </div>
    </header>
  );
}
