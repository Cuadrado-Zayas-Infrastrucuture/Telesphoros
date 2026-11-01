import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { ChartColumn, FileText, LogOut, Menu, MessageSquare, PanelLeftClose, PanelLeftOpen, Settings, Sparkles, SquarePen, Upload, X } from 'lucide-react';
import productMark from '@/assets/telesphoros-shield-rx.png';
import { useAuth } from '@/auth/AuthProvider';
import { ADMIN_ROLES, CLINICAL_READ_ROLES, primaryRole, WRITER_ROLES } from '@/auth/roles';
import { SidebarPatients } from '@/components/workspace/SidebarPatients';
import { SidebarReports } from '@/components/workspace/SidebarReports';
import { LOCAL_WORKSPACE_PATH, localWorkspaceAvailable, WORKSPACE_PATH } from '@/lib/localWorkspace';
import { preferenceStorage } from '@/lib/storageConsent';
import { readSidebarCollapsed, writeSidebarCollapsed } from '@/lib/sidebarPreference';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/Button';

type PanelItem = { kind: 'link'; to: string; label: string; icon: typeof FileText; show: boolean } | { kind: 'reports' | 'patients'; show: boolean };

/**
 * The frame of every signed-in page (specs/018-unified-sidebar). On desktop it collapses to icons, remembered in this browser; the layout
 * narrows its column through `.workspace-layout:has(.is-collapsed)`. On small screens it is a disclosure menu instead.
 */
export function WorkspaceSidebar() {
  const { status, roles, signOut } = useAuth();
  const [open, setOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(readSidebarCollapsed);
  useEffect(() => preferenceStorage.subscribe(() => setCollapsed(readSidebarCollapsed())), []);
  function toggleCollapsed() {
    setCollapsed((current) => {
      writeSidebarCollapsed(!current);
      return !current;
    });
  }
  const toggle = useRef<HTMLButtonElement>(null);
  const header = useRef<HTMLElement>(null);
  const canRead = roles.some((role) => CLINICAL_READ_ROLES.includes(role));
  // The local previews promise to make no API request of their own (local-e2e checks it), so their pages keep the panel's lists out.
  const { pathname } = useLocation();
  const lists = canRead && !pathname.startsWith('/local-');
  // The feature panel (specs/024 D2): these items, in this order, each only for the roles that may use it. A string is a link; a section is a list on the page.
  const everything: PanelItem[] = [
    ...(localWorkspaceAvailable()
      ? [
          { kind: 'link' as const, to: LOCAL_WORKSPACE_PATH, label: 'Workspace', icon: Sparkles, show: true },
          { kind: 'link' as const, to: '/local-interpretation', label: 'Chat preview', icon: MessageSquare, show: true },
        ]
      : []),
    { kind: 'link', to: WORKSPACE_PATH, label: 'New chat', icon: SquarePen, show: status === 'signedIn' },
    { kind: 'reports', show: lists },
    { kind: 'patients', show: lists },
    { kind: 'link', to: '/reports/upload', label: 'Upload report', icon: Upload, show: roles.some((role) => WRITER_ROLES.includes(role)) },
    { kind: 'link', to: '/reports', label: 'All reports', icon: FileText, show: canRead },
    { kind: 'link', to: '/usage', label: 'Usage', icon: ChartColumn, show: roles.some((role) => ADMIN_ROLES.includes(role)) },
    { kind: 'link', to: '/settings', label: 'Settings', icon: Settings, show: status === 'signedIn' },
  ];
  const items = everything.filter((item) => item.show);
  // The open drawer (phones only: the menu button is hidden on desktop) keeps Tab inside it and closes on Escape from anywhere in it.
  useEffect(() => {
    if (!open) return;
    const handle = (event: globalThis.KeyboardEvent) => {
      const frame = header.current;
      if (!frame || !(document.activeElement instanceof Node) || !frame.contains(document.activeElement)) return;
      if (event.key === 'Escape') {
        setOpen(false);
        toggle.current?.focus();
        return;
      }
      if (event.key !== 'Tab') return;
      const controls = [...frame.querySelectorAll<HTMLElement>('a[href], button, input, select, textarea')].filter(
        (element) => !element.matches(':disabled') && element.tabIndex >= 0 && element.getClientRects().length > 0,
      );
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', handle);
    return () => document.removeEventListener('keydown', handle);
  }, [open]);
  function dismiss(event: KeyboardEvent<HTMLElement>) {
    if (event.key === 'Escape' && open) {
      setOpen(false);
      toggle.current?.focus();
    }
  }
  return (
    <header ref={header} className={cn('workspace-navigation', collapsed && 'is-collapsed')}>
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
            {items.map((item) =>
              item.kind === 'link' ? (
                <li key={item.to}>
                  <NavLink
                    to={item.to}
                    end
                    data-panel-item={item.label}
                    onKeyDown={dismiss}
                    onClick={() => setOpen(false)}
                    title={collapsed ? item.label : undefined}
                    className={({ isActive }) =>
                      cn(
                        'flex min-h-control items-center gap-3 rounded-md px-3 py-2 text-sm font-medium hover:bg-muted',
                        isActive ? 'bg-muted text-primary' : 'text-muted-foreground',
                      )
                    }
                  >
                    <item.icon aria-hidden="true" className="size-4 shrink-0" />
                    <span className="workspace-link-label">{item.label}</span>
                  </NavLink>
                </li>
              ) : (
                <li key={item.kind} className="workspace-panel-item">
                  {item.kind === 'reports' ? <SidebarReports /> : <SidebarPatients />}
                </li>
              ),
            )}
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
