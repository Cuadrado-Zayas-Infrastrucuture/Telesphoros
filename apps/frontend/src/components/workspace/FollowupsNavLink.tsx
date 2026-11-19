import { CalendarClock } from 'lucide-react';
import type { KeyboardEvent } from 'react';
import { LazyTooltip } from '@/components/arc/LazyTooltip';
import { SidebarLink } from '@/components/layout/SidebarLink';
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
    <LazyTooltip label={collapsed ? label : undefined} side="right">
      <SidebarLink to="/follow-ups" end data-panel-item="Follow-ups" onKeyDown={onKeyDown} onClick={onClick} styleFor={className}>
        <CalendarClock aria-hidden="true" className="size-4 shrink-0" />
        <span className="workspace-link-label">{label}</span>
      </SidebarLink>
    </LazyTooltip>
  );
}
