import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { ChartColumn, ChevronsUpDown, FileText, House, Menu, MessageSquare, PanelLeftClose, PanelLeftOpen, Sparkles, Users, X } from 'lucide-react';
import productMark from '@/assets/telesphoros-shield-rx.png';
import { useAuth } from '@/auth/AuthProvider';
import { useMediaQuery } from '@/hooks/useMediaQuery';
import { ADMIN_ROLES, CLINICAL_READ_ROLES, primaryRole } from '@/auth/roles';
import { LazyTooltip } from '@/components/arc/LazyTooltip';
import { SidebarLink } from '@/components/layout/SidebarLink';
import { HelpButton } from '@/components/help/HelpButton';
import { FollowupsNavLink } from '@/components/workspace/FollowupsNavLink';
import { SidebarReports } from '@/components/workspace/SidebarReports';
import { LOCAL_WORKSPACE_PATH, localWorkspaceAvailable, WORKSPACE_PATH } from '@/lib/localWorkspace';
import { preferenceStorage } from '@/lib/storageConsent';
import { clampSidebarWidth, readSidebarCollapsed, readSidebarWidth, SIDEBAR_WIDTH, writeSidebarCollapsed, writeSidebarWidth } from '@/lib/sidebarPreference';
import { cn } from '@/lib/utils';
import { SidebarAccountMenu } from '@/components/layout/SidebarAccountMenu';
import { Button } from '@/components/ui/Button';
import { SIDEBAR_WORDS } from '@/lib/words/shell';
import { useWords } from '@/lib/words/screens';

// `panel` is a fixed name for the tests and the panel's own markup; `label` is the word shown, in the shell's language (spec 050 LS2a).
type PanelItem = { kind: 'link'; to: string; panel: string; label: string; icon: typeof FileText; show: boolean } | { kind: 'followups'; show: boolean };

/**
 * The frame of every signed-in page (specs/018-unified-sidebar), laid out as specs/034: Home (the worklist, spec 049), Help, a short block
 * of destinations, one Recents list that takes the remaining height, and the account pinned at the bottom. On desktop it collapses to icons,
 * remembered in this browser; the layout narrows its column through `.workspace-layout:has(.is-collapsed)`. On small screens it is a
 * disclosure menu instead.
 */
export function WorkspaceSidebar() {
  const { status, roles, preferredName } = useAuth();
  const words = useWords(SIDEBAR_WORDS);
  const [open, setOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(readSidebarCollapsed);
  const [width, setWidth] = useState(readSidebarWidth);
  // Specs/042 D10: the collapse to icons applies only at the desktop width (`@media (min-width: 64rem)` in styles/workspace.css). Below it the
  // sidebar is a menu that shows every name, so a stored collapse must not give its links a tooltip that repeats the visible word.
  const iconsOnly = useMediaQuery('(min-width: 64rem)', true) && collapsed;
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
  // The destinations (specs/034 D1, replacing the order of specs/024 D2), each only for the roles that may use it. Home sits above them (spec 049),
  // Recents below them, and Settings with Sign out in the account menu at the bottom. The chat is gone (spec 052 RC1b, RC-6); Help stays.
  const everything: PanelItem[] = [
    ...(localWorkspaceAvailable()
      ? [
          { kind: 'link' as const, to: LOCAL_WORKSPACE_PATH, panel: 'Workspace', label: words.workspace, icon: Sparkles, show: true },
          { kind: 'link' as const, to: '/local-interpretation', panel: 'AI preview', label: words.aiPreview, icon: MessageSquare, show: true },
        ]
      : []),
    { kind: 'link', to: '/patients', panel: 'Patients', label: words.patients, icon: Users, show: canRead },
    { kind: 'link', to: '/reports', panel: 'Reports', label: words.reports, icon: FileText, show: canRead },
    { kind: 'followups', show: followups },
    { kind: 'link', to: '/usage', panel: 'Usage', label: words.usage, icon: ChartColumn, show: roles.some((role) => ADMIN_ROLES.includes(role)) },
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
  const primary = primaryRole(roles);
  const roleWords = { admin: words.roleAdmin, reviewer: words.roleReviewer, clinician: words.roleClinician, reader: words.roleReader };
  const role = primary ? roleWords[primary] : words.roleNone;
  const linkClass = ({ isActive }: { isActive: boolean }) =>
    cn('flex min-h-control items-center gap-3 rounded-md px-3 py-2 text-sm font-medium hover:bg-muted', isActive ? 'bg-muted text-primary' : 'text-muted-foreground');
  return (
    <header ref={header} className={cn('workspace-navigation', collapsed && 'is-collapsed')} style={{ '--size-sidebar': `${width}rem` } as CSSProperties}>
      <div className="workspace-brand-row">
        <NavLink to="/" onClick={close} className="workspace-brand inline-flex min-h-control min-w-0 items-center gap-2 rounded-sm">
          {/* Specs/034 D7: the wordmark alone; the byline stays on the public pages and the sign-in header. */}
          <img src={productMark} alt={words.logoAlt} width="64" height="66" loading="eager" className="brand-mark h-auto w-9 shrink-0" />
          <span className="workspace-brand-text min-w-0 truncate font-heading text-lg font-semibold tracking-tight">Telesphoros</span>
        </NavLink>
        <LazyTooltip label={collapsed ? words.expand : words.collapse} side={collapsed ? 'right' : 'bottom'}>
          <Button
            variant="ghost"
            size="sm"
            className="workspace-collapse-toggle shrink-0 text-muted-foreground"
            aria-label={collapsed ? words.expand : words.collapse}
            onClick={toggleCollapsed}
          >
            {collapsed ? <PanelLeftOpen aria-hidden="true" className="size-4" /> : <PanelLeftClose aria-hidden="true" className="size-4" />}
          </Button>
        </LazyTooltip>
        <Button
          onKeyDown={dismiss}
          ref={toggle}
          variant="ghost"
          size="sm"
          aria-label={words.menu}
          aria-expanded={open}
          aria-controls="workspace-navigation-content"
          className="workspace-menu-toggle"
          onClick={() => setOpen((current) => !current)}
        >
          {open ? <X aria-hidden="true" className="size-5" /> : <Menu aria-hidden="true" className="size-5" />}
        </Button>
      </div>
      <div id="workspace-navigation-content" className={cn('workspace-navigation-content', open && 'is-open')}>
        <nav aria-label={words.primary} className="workspace-primary flex min-h-0 flex-1 flex-col gap-5">
          <ul className="flex flex-col gap-0.5">
            {status === 'signedIn' && canRead && (
              <li>
                {/* Collapsed to icons, each destination shows its name in a tooltip beside it (specs/018 D3, specs/042 D6). */}
                <LazyTooltip label={iconsOnly ? words.home : undefined} side="right">
                  <SidebarLink to={WORKSPACE_PATH} end data-panel-item="Home" onKeyDown={dismiss} onClick={close} styleFor={linkClass}>
                    <House aria-hidden="true" className="size-4 shrink-0" />
                    <span className="workspace-link-label">{words.home}</span>
                  </SidebarLink>
                </LazyTooltip>
              </li>
            )}
            {items.map((item) =>
              item.kind === 'link' ? (
                <li key={item.to}>
                  <LazyTooltip label={iconsOnly ? item.label : undefined} side="right">
                    <SidebarLink to={item.to} end data-panel-item={item.panel} onKeyDown={dismiss} onClick={close} styleFor={linkClass}>
                      <item.icon aria-hidden="true" className="size-4 shrink-0" />
                      <span className="workspace-link-label">{item.label}</span>
                    </SidebarLink>
                  </LazyTooltip>
                </li>
              ) : (
                <li key={item.kind}>
                  <FollowupsNavLink iconsOnly={iconsOnly} className={linkClass} onClick={close} onKeyDown={dismiss} />
                </li>
              ),
            )}
            {status === 'signedIn' && (
              <li>
                <HelpButton iconsOnly={iconsOnly} onKeyDown={dismiss} />
              </li>
            )}
          </ul>
          {lists && <SidebarReports onNavigate={close} />}
        </nav>
        <div className="workspace-account relative border-t border-divider pt-3">
          <LazyTooltip label={iconsOnly ? words.account(role) : undefined} side="right">
            <button
              ref={accountToggle}
              type="button"
              onKeyDown={dismiss}
              aria-label={words.account(role)}
              aria-expanded={accountOpen}
              aria-controls="workspace-account-menu"
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
                <span className="block truncate text-xs text-muted-foreground">{preferredName ? words.roleSynthetic(role) : words.syntheticEnvironment}</span>
              </span>
              <ChevronsUpDown aria-hidden="true" className="workspace-link-label size-4 shrink-0 text-muted-foreground" />
            </button>
          </LazyTooltip>
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
          aria-label={words.width}
          aria-controls="workspace-navigation-content"
          aria-valuemin={SIDEBAR_WIDTH.min}
          aria-valuemax={SIDEBAR_WIDTH.max}
          aria-valuenow={width}
          aria-valuetext={words.widthValue(String(width))}
          tabIndex={0}
          title={words.resizeHint}
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
