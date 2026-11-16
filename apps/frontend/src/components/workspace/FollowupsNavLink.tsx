import { CalendarClock } from 'lucide-react';
import type { KeyboardEvent } from 'react';
import { NavLink } from 'react-router-dom';
import { useFollowups } from '@/hooks/useFollowups';
import type { FollowupInboxFilters } from '@telesphoros/shared-types';

const allFilters: FollowupInboxFilters = { assignment: 'all', status: 'all' };

/** The sidebar's Follow-ups destination: a link to the page (specs/041 C2), with the clinic's overdue and due-today count beside it. */
export function FollowupsNavLink({
  collapsed,
  className,
  onClick,
  onKeyDown,
}: {
  collapsed: boolean;
  className: (state: { isActive: boolean }) => string;
  onClick: () => void;
  onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
}) {
  const { data, error } = useFollowups(undefined, undefined, allFilters);
  const label = `Follow-ups${data && !error ? ` (${data.counts.overdue + data.counts.today})` : ''}`;
  return (
    <NavLink to="/follow-ups" end data-panel-item="Follow-ups" onKeyDown={onKeyDown} onClick={onClick} title={collapsed ? label : undefined} className={className}>
      <CalendarClock aria-hidden="true" className="size-4 shrink-0" />
      <span className="workspace-link-label">{label}</span>
    </NavLink>
  );
}
