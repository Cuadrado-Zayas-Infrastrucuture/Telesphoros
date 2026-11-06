import { useId, useState, type ReactNode } from 'react';
import { ChevronRight, type LucideIcon } from 'lucide-react';
import { ACCOUNT_MENU_ICON, ACCOUNT_MENU_ROW, type AccountMenuKeyHandler } from '@/lib/accountMenu';
import { cn } from '@/lib/utils';

/** An account-menu row that opens a short list in place, below it (Language, Help, Learn more): no flyout, so it works the same on a phone. */
export function AccountMenuDisclosure({
  icon: Icon,
  label,
  value,
  onKeyDown,
  children,
}: {
  icon: LucideIcon;
  label: string;
  value?: string;
  onKeyDown: AccountMenuKeyHandler;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <li>
      <button type="button" aria-expanded={open} aria-controls={id} onKeyDown={onKeyDown} className={ACCOUNT_MENU_ROW} onClick={() => setOpen((current) => !current)}>
        <Icon aria-hidden="true" className={ACCOUNT_MENU_ICON} />
        <span className="min-w-0 flex-1 truncate">{label}</span>
        {value && <span className="text-xs text-muted-foreground">{value}</span>}
        <ChevronRight aria-hidden="true" className={cn('size-3.5 shrink-0 text-muted-foreground transition-transform', open && 'rotate-90')} />
      </button>
      <ul id={id} hidden={!open} className="flex flex-col pl-7">
        {children}
      </ul>
    </li>
  );
}
