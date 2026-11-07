import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { ChartColumn, ChevronsUpDown, FileText, Menu, MessageSquare, PanelLeftClose, PanelLeftOpen, Sparkles, SquarePen, Users, X } from 'lucide-react';
import productMark from '@/assets/telesphoros-shield-rx.png';
import { useAuth } from '@/auth/AuthProvider';
import { ADMIN_ROLES, CLINICAL_READ_ROLES, primaryRole } from '@/auth/roles';
import { FollowupInbox } from '@/components/workspace/FollowupInbox';
import { SidebarReports } from '@/components/workspace/SidebarReports';
import { LOCAL_WORKSPACE_PATH, localWorkspaceAvailable, WORKSPACE_PATH } from '@/lib/localWorkspace';
import { preferenceStorage } from '@/lib/storageConsent';
import { clampSidebarWidth, readSidebarCollapsed, readSidebarWidth, SIDEBAR_WIDTH, writeSidebarCollapsed, writeSidebarWidth } from '@/lib/sidebarPreference';
import { cn } from '@/lib/utils';
import { SidebarAccountMenu } from '@/components/layout/SidebarAccountMenu';
import { announceNewChat } from '@/lib/workspaceEvents';
import { Button } from '@/components/ui/Button';

type PanelItem = { kind: 'link'; to: string; label: string; icon: typeof FileText; show: boolean } | { kind: 'followups'; show: boolean };

/**
 * The frame of every signed-in page (specs/018-unified-sidebar), laid out as specs/034: New chat, a short block of destinations, one Recents
 * list that takes the remaining height, and the account pinned at the bottom. On desktop it collapses to icons, remembered in this browser; the
 * layout narrows its column through `.workspace-layout:has(.is-collapsed)`. On small screens it is a disclosure menu instead.
 */
export function WorkspaceSidebar() {
  const { status, roles, preferredName } = useAuth();
  const [open, setOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(readSidebarCollapsed);
  const [width, setWidth] = useState(readSidebarWidth);
  useEffect(
    () =>
      preferenceStorage.subscribe(() => {
        setCollapsed(readSidebarCollapsed());
        setWidth(readSidebarWidth());
      }),
    [],
  );
  // Specs/034 D8: the right edge drags the desktop width, within fixed bounds. The arrow keys, Home and End do the same; a double click restores the default.
  const drag = useRef<{ startX: number; startWidth: number; rootPx: number } | null>(null);
  function resizeTo(rem: number, keep = true) {
    const next = clampSidebarWidth(rem);
    setWidth(next);
    if (keep) writeSidebarWidth(next);
  }
  function startDrag(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    drag.current = { startX: event.clientX, startWidth: width, rootPx: parseFloat(getComputedStyle(document.documentElement).fontSize) || 16 };
    document.body.classList.add('is-resizing-sidebar');
  }
  function moveDrag(event: ReactPointerEvent<HTMLDivElement>) {
    const current = drag.current;
    if (current) resizeTo(current.startWidth + (event.clientX - current.startX) / current.rootPx, false);
  }
  function endDrag() {
    if (!drag.current) return;
    drag.current = null;
    document.body.classList.remove('is-resizing-sidebar');
    writeSidebarWidth(width);
  }
  function resizeByKey(event: KeyboardEvent<HTMLDivElement>) {
    const next =
      event.key === 'ArrowLeft'
        ? width - SIDEBAR_WIDTH.step
        : event.key === 'ArrowRight'
          ? width + SIDEBAR_WIDTH.step
          : event.key === 'Home'
            ? SIDEBAR_WIDTH.min
            : event.key === 'End'
              ? SIDEBAR_WIDTH.max
              : null;
    if (next === null) return;
    event.preventDefault();
    resizeTo(next);
  }
  function toggleCollapsed() {
    setCollapsed((current) => {
      writeSidebarCollapsed(!current);
      return !current;
    });
  }
  const toggle = useRef<HTMLButtonElement>(null);
  const header = useRef<HTMLElement>(null);
  const [accountOpen, setAccountOpen] = useState(false);
  const accountToggle = useRef<HTMLButtonElement>(null);
  const canRead = roles.some((role) => CLINICAL_READ_ROLES.includes(role));
  // The local previews promise to make no API request of their own (local-e2e checks it), so their pages keep the panel's lists out.
  const { pathname } = useLocation();
  const lists = canRead && !pathname.startsWith('/local-');
  const followups = lists && roles.some((role) => role === 'clinician' || role === 'reviewer');
  // The destinations (specs/034 D1, replacing the order of specs/024 D2), each only for the roles that may use it. New chat sits above them,
  // Recents below them, and Settings with Sign out in the account menu at the bottom.
  const everything: PanelItem[] = [
    ...(localWorkspaceAvailable()
      ? [
          { kind: 'link' as const, to: LOCAL_WORKSPACE_PATH, label: 'Workspace', icon: Sparkles, show: true },
          { kind: 'link' as const, to: '/local-interpretation', label: 'Chat preview', icon: MessageSquare, show: true },
        ]
      : []),
    { kind: 'link', to: '/patients', label: 'Patients', icon: Users, show: canRead },
    { kind: 'link', to: '/reports', label: 'Reports', icon: FileText, show: canRead },
    { kind: 'followups', show: followups },
    { kind: 'link', to: '/usage', label: 'Usage', icon: ChartColumn, show: roles.some((role) => ADMIN_ROLES.includes(role)) },
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
  // The account menu closes on Escape (returning focus to its button) and on a click anywhere outside it.
  useEffect(() => {
    if (!accountOpen) return;
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      setAccountOpen(false);
      accountToggle.current?.focus();
    };
    const onPointer = (event: PointerEvent) => {
      if (event.target instanceof Node && accountToggle.current?.parentElement?.contains(event.target)) return;
      setAccountOpen(false);
    };
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('pointerdown', onPointer);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('pointerdown', onPointer);
    };
  }, [accountOpen]);
  function close() {
    setOpen(false);
    setAccountOpen(false);
  }
  function dismiss(event: KeyboardEvent<HTMLElement>) {
    if (event.key === 'Escape' && open) {
      setOpen(false);
      toggle.current?.focus();
    }
  }
  const role = primaryRole(roles) ?? 'user with no role';
  const linkClass = ({ isActive }: { isActive: boolean }) =>
    cn('flex min-h-control items-center gap-3 rounded-md px-3 py-2 text-sm font-medium hover:bg-muted', isActive ? 'bg-muted text-primary' : 'text-muted-foreground');
  return (
    <header ref={header} className={cn('workspace-navigation', collapsed && 'is-collapsed')} style={{ '--size-sidebar': `${width}rem` } as CSSProperties}>
      <div className="workspace-brand-row">
        <NavLink to="/" onClick={close} className="workspace-brand inline-flex min-h-control min-w-0 items-center gap-2 rounded-sm">
          {/* Specs/034 D7: the wordmark alone; the byline stays on the public pages and the sign-in header. */}
          <img src={productMark} alt="Telesphoros shield and Rx logo" width="64" height="66" loading="eager" className="brand-mark h-auto w-9 shrink-0" />
          <span className="workspace-brand-text min-w-0 truncate font-heading text-lg font-semibold tracking-tight">Telesphoros</span>
        </NavLink>
        <Button
          variant="ghost"
          size="sm"
          className="workspace-collapse-toggle shrink-0 text-muted-foreground"
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          onClick={toggleCollapsed}
        >
          {collapsed ? <PanelLeftOpen aria-hidden="true" className="size-4" /> : <PanelLeftClose aria-hidden="true" className="size-4" />}
        </Button>
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
        <nav aria-label="Primary" className="workspace-primary flex min-h-0 flex-1 flex-col gap-5">
          <ul className="flex flex-col gap-0.5">
            {status === 'signedIn' && (
              <li>
                <NavLink
                  to={WORKSPACE_PATH}
                  end
                  data-panel-item="New chat"
                  onKeyDown={dismiss}
                  onClick={() => {
                    announceNewChat();
                    close();
                  }}
                  title={collapsed ? 'New chat' : undefined}
                  className={({ isActive }) =>
                    cn('workspace-new-chat flex min-h-control items-center gap-3 rounded-md px-3 py-2 text-sm font-semibold text-primary hover:bg-muted', isActive && 'bg-muted')
                  }
                >
                  <SquarePen aria-hidden="true" className="size-4 shrink-0" />
                  <span className="workspace-link-label">New chat</span>
                </NavLink>
              </li>
            )}
            {items.map((item) =>
              item.kind === 'link' ? (
                <li key={item.to}>
                  <NavLink to={item.to} end data-panel-item={item.label} onKeyDown={dismiss} onClick={close} title={collapsed ? item.label : undefined} className={linkClass}>
                    <item.icon aria-hidden="true" className="size-4 shrink-0" />
                    <span className="workspace-link-label">{item.label}</span>
                  </NavLink>
                </li>
              ) : (
                <li key={item.kind} data-panel-item="Follow-ups">
                  <FollowupInbox onNavigate={close} />
                </li>
              ),
            )}
          </ul>
          {lists && <SidebarReports onNavigate={close} />}
        </nav>
        <div className="workspace-account relative border-t border-divider pt-3">
          <button
            ref={accountToggle}
            type="button"
            onKeyDown={dismiss}
            aria-label={`Account, ${role}`}
            aria-expanded={accountOpen}
            aria-controls="workspace-account-menu"
            title={collapsed ? `Account, ${role}` : undefined}
            onClick={() => setAccountOpen((current) => !current)}
            className={cn(
              'workspace-account-toggle flex min-h-control w-full items-center gap-3 rounded-md px-2 py-2 text-left hover:bg-muted',
              (accountOpen || pathname === '/settings') && 'bg-muted',
            )}
          >
            <span aria-hidden="true" className="grid size-8 shrink-0 place-items-center rounded-full bg-muted text-sm font-semibold text-foreground">
              {(preferredName ?? role).charAt(0).toUpperCase()}
            </span>
            {/* The preferred name when set (Settings), with the role beside the environment, as a chat app shows the name and the plan. */}
            <span className="workspace-link-label min-w-0 flex-1">
              <span className="block truncate text-sm font-medium text-foreground">{preferredName ?? role}</span>
              <span className="block truncate text-xs text-muted-foreground">{preferredName ? `${role} · Synthetic` : 'Synthetic environment'}</span>
            </span>
            <ChevronsUpDown aria-hidden="true" className="workspace-link-label size-4 shrink-0 text-muted-foreground" />
          </button>
          <div
            id="workspace-account-menu"
            hidden={!accountOpen}
            className="workspace-account-menu absolute bottom-full left-0 z-20 mb-2 w-60 rounded-md border border-divider bg-panel p-1 shadow-panel"
          >
            <SidebarAccountMenu open={accountOpen} name={preferredName ?? role} onClose={close} onKeyDown={dismiss} />
          </div>
        </div>
      </div>
      {!collapsed && (
        <div
          // A slider (not a focusable separator): it sets one value, the width, from the mouse or the keys.
          role="slider"
          aria-orientation="horizontal"
          aria-label="Sidebar width"
          aria-controls="workspace-navigation-content"
          aria-valuemin={SIDEBAR_WIDTH.min}
          aria-valuemax={SIDEBAR_WIDTH.max}
          aria-valuenow={width}
          aria-valuetext={`${width} rem wide`}
          tabIndex={0}
          title="Drag to resize. Double-click to reset."
          className="workspace-resize-handle"
          onPointerDown={startDrag}
          onPointerMove={moveDrag}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onLostPointerCapture={endDrag}
          onKeyDown={resizeByKey}
          onDoubleClick={() => resizeTo(SIDEBAR_WIDTH.default)}
        />
      )}
    </header>
  );
}
