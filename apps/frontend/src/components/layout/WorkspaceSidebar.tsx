import { useRef, useState, type KeyboardEvent } from 'react';
import { NavLink } from 'react-router-dom';
import { ChartColumn, FileText, Home, LogOut, Menu, MessageSquare, PanelLeftClose, PanelLeftOpen, Settings, Sparkles, Upload, X } from 'lucide-react';
import productMark from '@/assets/telesphoros-shield-rx.png';
import { useAuth } from '@/auth/AuthProvider';
import { ADMIN_ROLES, CLINICAL_READ_ROLES, primaryRole, WRITER_ROLES } from '@/auth/roles';
import { readSidebarCollapsed, writeSidebarCollapsed } from '@/lib/sidebarPreference';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/Button';

/**
 * The frame of every signed-in page (specs/018-unified-sidebar). On desktop it collapses to icons, remembered in this browser; the layout
 * narrows its column through `.workspace-layout:has(.is-collapsed)`. On small screens it is a disclosure menu instead.
 */
export function WorkspaceSidebar() {
  const { status, roles, signOut } = useAuth();
  const [open, setOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(readSidebarCollapsed);
  function toggleCollapsed() {
    setCollapsed((current) => {
      writeSidebarCollapsed(!current);
      return !current;
    });
  }
  const toggle = useRef<HTMLButtonElement>(null);
  const links = [
    ...(import.meta.env.DEV && location.hostname === '127.0.0.1'
      ? [
          { to: '/local-workspace', label: 'Workspace preview', icon: Sparkles, show: true },
          { to: '/local-interpretation', label: 'Chat preview', icon: MessageSquare, show: true },
        ]
      : []),
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
    <header className={cn('workspace-navigation', collapsed && 'is-collapsed')}>
      <div className="workspace-brand-row">
        <NavLink to="/" onClick={() => setOpen(false)} className="workspace-brand inline-flex min-w-0 items-center gap-2 rounded-sm">
          <img src={productMark} alt="Telesphoros shield and Rx logo" width="64" height="66" loading="eager" className="brand-mark h-auto w-16 shrink-0" />
          <span className="workspace-brand-text min-w-0">
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
          <p className="workspace-group-label mb-3 px-3 text-xs font-medium text-muted-foreground">Workspace</p>
          <ul className="flex flex-col gap-1">
            {links.map(({ to, label, icon: Icon }) => (
              <li key={to}>
                <NavLink
                  to={to}
                  end
                  onKeyDown={dismiss}
                  onClick={() => setOpen(false)}
                  title={collapsed ? label : undefined}
                  className={({ isActive }) =>
                    cn(
                      'flex min-h-control items-center gap-3 rounded-md px-3 py-2 text-sm font-medium hover:bg-muted',
                      isActive ? 'bg-muted text-primary' : 'text-muted-foreground',
                    )
                  }
                >
                  <Icon aria-hidden="true" className="size-4 shrink-0" />
                  <span className="workspace-link-label">{label}</span>
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>
        <div className="workspace-account flex flex-col gap-3 border-t border-divider pt-4">
          {/* The full block, or (desktop, collapsed) one icon; CSS picks, so a phone never inherits the desktop choice. */}
          <div className="workspace-account-full flex flex-col gap-2">
            <p className="px-3 text-xs text-muted-foreground">
              Synthetic environment.
              <br />
              Clinical use not approved.
            </p>
            <p className="px-3 text-xs text-muted-foreground">
              Signed in as <strong className="text-foreground">{primaryRole(roles) ?? 'user with no role'}</strong>
            </p>
            <Button variant="ghost" className="min-h-control w-full justify-start gap-3 px-3 text-sm font-medium text-muted-foreground" onClick={() => void signOut()}>
              <LogOut aria-hidden="true" className="size-4 shrink-0" />
              Sign out
            </Button>
          </div>
          <Button variant="ghost" size="sm" className="workspace-account-compact text-muted-foreground" aria-label="Sign out" title="Sign out" onClick={() => void signOut()}>
            <LogOut aria-hidden="true" className="size-4" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="workspace-collapse-toggle self-start"
            aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            onClick={toggleCollapsed}
          >
            {collapsed ? <PanelLeftOpen aria-hidden="true" className="size-4" /> : <PanelLeftClose aria-hidden="true" className="size-4" />}
          </Button>
        </div>
      </div>
    </header>
  );
}
