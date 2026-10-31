import { type KeyboardEvent, useMemo, useRef, useState } from 'react';
import type { UsageDaysDto } from '@telesphoros/shared-types';
import { formatCount } from '@/lib/usage';
import { buildUsageCalendar, type DayCell, dayName } from '@/lib/usageCalendar';
import { cn } from '@/lib/utils';

const SHADE = { 1: 'bg-usage-1', 2: 'bg-usage-2', 3: 'bg-usage-3', 4: 'bg-usage-4' } as const;
const DAY_LABELS = ['', 'Mon', '', 'Wed', '', 'Fri', ''];
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const uploads = (count: number) => `${formatCount(count)} ${count === 1 ? 'report' : 'reports'} uploaded`;
const describe = (cell: DayCell) => `${dayName(cell.date)}: ${cell.kind === 'counted' ? uploads(cell.count) : cell.kind === 'zero' ? 'no reports uploaded' : 'not counted'}`;

/** One loaded year (specs/028-usage-heatmap): the summary, the day grid (D7, D8), its readout and key, and the month table (D9). */
export function UsageCalendarYear({ days }: { days: UsageDaysDto }) {
  const calendar = useMemo(() => buildUsageCalendar(days), [days]);
  const order = useMemo(() => calendar.weeks.flatMap((week) => week.days).filter((cell) => cell !== null), [calendar]);
  const position = useMemo(() => new Map(order.map((cell, index) => [cell.date, index])), [order]);
  const cellRefs = useRef<Array<HTMLSpanElement | null>>([]);
  const [active, setActive] = useState<number | null>(null);
  const summary = `${days.year}: ${uploads(calendar.total)}.${calendar.busiest ? ` Busiest day: ${dayName(calendar.busiest.date)}, with ${uploads(calendar.busiest.count)}.` : ''}`;
  const todayIndex = position.get(days.today) ?? 0;
  // One tab stop (the ARIA grid pattern): the active day, or today, or 1 January when today is in another year.
  const tabStop = active ?? todayIndex;
  const activeCell = active === null ? undefined : order[active];

  // Arrow keys move one day up or down a column, or one week across; focus follows, and the readout below says what the day holds.
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = { ArrowUp: -1, ArrowDown: 1, ArrowLeft: -7, ArrowRight: 7 }[event.key];
    if (step === undefined) return;
    event.preventDefault();
    const next = Math.min(order.length - 1, Math.max(0, tabStop + step));
    setActive(next);
    cellRefs.current[next]?.focus();
  };

  return (
    <div className="flex flex-col gap-4">
      <p>{summary}</p>
      <div className="overflow-x-auto py-2">
        <div aria-hidden="true" className="flex w-max gap-0.5">
          <span className="w-8 shrink-0" />
          {calendar.weeks.map((week, weekIndex) => (
            <span key={weekIndex} className="h-4 w-3 shrink-0 text-xs whitespace-nowrap text-muted-foreground">
              {week.monthLabel}
            </span>
          ))}
        </div>
        <div
          role="grid"
          tabIndex={-1}
          aria-label={`Uploads per day, ${summary}`}
          aria-describedby="usage-calendar-readout"
          onKeyDown={onKeyDown}
          className="flex w-max flex-col gap-0.5"
        >
          {WEEKDAYS.map((weekday, row) => (
            <div key={weekday} role="row" className="flex gap-0.5">
              <span role="rowheader" className="w-8 shrink-0 text-xs leading-3 text-muted-foreground">
                <span aria-hidden="true">{DAY_LABELS[row]}</span>
                <span className="sr-only">{weekday}</span>
              </span>
              {calendar.weeks.map((week, weekIndex) => {
                const cell = week.days[row] ?? null;
                if (cell === null) return <span key={weekIndex} role="gridcell" className="size-3 shrink-0" />;
                const index = position.get(cell.date)!;
                return (
                  <span
                    key={cell.date}
                    ref={(element) => {
                      cellRefs.current[index] = element;
                    }}
                    role="gridcell"
                    tabIndex={index === tabStop ? 0 : -1}
                    aria-label={describe(cell)}
                    data-date={cell.date}
                    data-kind={cell.kind}
                    title={describe(cell)}
                    onFocus={() => setActive(index)}
                    onMouseEnter={() => setActive(index)}
                    className={cn(
                      'size-3 shrink-0 rounded-sm focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring',
                      cell.kind === 'counted' && SHADE[cell.shade],
                      cell.kind === 'zero' && 'bg-muted',
                      cell.kind === 'not-counted' && 'border border-divider',
                      index === active && 'outline-2 outline-offset-1 outline-ring',
                    )}
                  />
                );
              })}
            </div>
          ))}
        </div>
      </div>
      <p id="usage-calendar-readout" aria-live="polite" className="text-sm text-muted-foreground">
        {activeCell ? describe(activeCell) : 'Point at a day, or move through the calendar with the arrow keys, to see its count.'}
      </p>
      <div aria-hidden="true" className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span>Fewer</span>
        {['bg-muted', SHADE[1], SHADE[2], SHADE[3], SHADE[4]].map((shade) => (
          <span key={shade} className={cn('size-3 rounded-sm', shade)} />
        ))}
        <span>More</span>
        <span className="ml-4 size-3 rounded-sm border border-divider" />
        <span>Not counted</span>
      </div>
      <table className="w-full text-left text-sm">
        <caption className="pb-2 text-left text-muted-foreground">Reports uploaded per month, {days.year}</caption>
        <thead className="text-xs text-muted-foreground">
          <tr className="border-b border-divider">
            <th scope="col" className="px-2 py-2 font-medium">
              Month
            </th>
            <th scope="col" className="px-2 py-2 text-right font-medium">
              Reports uploaded
            </th>
          </tr>
        </thead>
        <tbody>
          {calendar.months.map(({ month, reportsUploaded }) => (
            <tr key={month} className="border-b border-divider last:border-b-0">
              <th scope="row" className="px-2 py-2 font-normal">
                {month}
              </th>
              <td className={cn('px-2 py-2 text-right', reportsUploaded === null && 'text-muted-foreground')}>
                {reportsUploaded === null ? 'Not counted' : formatCount(reportsUploaded)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
