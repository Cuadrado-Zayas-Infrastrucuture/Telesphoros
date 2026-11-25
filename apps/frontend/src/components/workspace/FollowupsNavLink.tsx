import { CalendarClock } from 'lucide-react';
import type { KeyboardEvent } from 'react';
import { LazyTooltip } from '@/components/arc/LazyTooltip';
import { SidebarLink } from '@/components/layout/SidebarLink';
import { useFollowups } from '@/hooks/useFollowups';
import type { FollowupInboxFilters } from '@telesphoros/shared-types';
import { SIDEBAR_WORDS } from '@/lib/words/shell';
import { useWords } from '@/lib/words/screens';

const allFilters: FollowupInboxFilters = { assignment: 'all', status: 'all' };

/** The sidebar's Follow-ups destination: a link to the page (specs/041 C2), with the clinic's overdue and due-today count beside it. */
export function FollowupsNavLink({
  iconsOnly,
  className,
  onClick,
  onKeyDown,
}: {
  /** The sidebar shows icons only (collapsed, at the desktop width): the name then shows in a tooltip. */
  iconsOnly: boolean;
  className: (state: { isActive: boolean }) => string;
  onClick: () => void;
  onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
}) {
  const { data, error } = useFollowups(undefined, undefined, allFilters);
  const words = useWords(SIDEBAR_WORDS);
  const label = data && !error ? words.followupsCount(String(data.counts.overdue + data.counts.today)) : words.followups;
  return (
    <LazyTooltip label={iconsOnly ? label : undefined} side="right">
      <SidebarLink to="/follow-ups" end data-panel-item="Follow-ups" onKeyDown={onKeyDown} onClick={onClick} styleFor={className}>
        <CalendarClock aria-hidden="true" className="size-4 shrink-0" />
        <span className="workspace-link-label">{label}</span>
      </SidebarLink>
    </LazyTooltip>
  );
}
