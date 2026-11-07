import type { ReactNode } from 'react';
import { ExternalLink, type LucideIcon } from 'lucide-react';
import { ACCOUNT_MENU_ICON, ACCOUNT_MENU_ROW, type AccountMenuKeyHandler } from '@/lib/accountMenu';

/** An account-menu link that leaves the app: a new tab, said aloud, and marked with the external-link icon. */
export function AccountMenuLink({ href, icon: Icon, children, onKeyDown }: { href: string; icon?: LucideIcon; children: ReactNode; onKeyDown: AccountMenuKeyHandler }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" onKeyDown={onKeyDown} className={ACCOUNT_MENU_ROW}>
      {Icon && <Icon aria-hidden="true" className={ACCOUNT_MENU_ICON} />}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      <span className="sr-only"> (opens in a new tab)</span>
      <ExternalLink aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
    </a>
  );
}
