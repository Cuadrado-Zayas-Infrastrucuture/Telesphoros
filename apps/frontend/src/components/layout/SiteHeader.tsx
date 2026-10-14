import productMark from '@/assets/telesphoros-shield-rx.png';
import { ownedStorageMode } from '@/lib/storageMode';
import { NavLink, useLocation } from 'react-router-dom';
import { useAuth } from '@/auth/AuthProvider';
import { WRITER_ROLES } from '@/auth/roles';
import { AccountMenu } from '@/components/layout/AccountMenu';
import { cn } from '@/lib/utils';

export function SiteHeader() {
  const landing = useLocation().pathname === '/' && !ownedStorageMode();
  const { roles } = useAuth();
  // Links to pages the user cannot use are simply not shown. The pages are guarded as well.
  const links = [
    { to: '/', label: 'Overview', end: true, show: !landing },
    { to: '/reports', label: 'Reports', end: true, show: ownedStorageMode() && roles.length > 0 },
    { to: '/reports/upload', label: 'Upload report', end: false, show: !ownedStorageMode() && roles.some((r) => WRITER_ROLES.includes(r)) },
  ].filter((link) => link.show);

  return (
    <header className={cn("border-b border-divider bg-background", landing && "landing-site-header")}>
      <div className="mx-auto flex max-w-page flex-wrap items-center justify-between gap-x-6 gap-y-3 px-4 py-4 sm:px-6">
        <NavLink to="/" className="inline-flex min-h-control min-w-0 max-w-full items-center gap-3 rounded-sm text-foreground">
          <img src={productMark} alt="Telesphoros shield and Rx logo" width="64" height="66" loading="eager" className="h-auto w-16 shrink-0" /><span className="flex min-w-0 flex-col wrap-anywhere"><span className="font-heading text-2xl font-semibold tracking-tight">Telesphoros</span>
          <span className="text-xs text-muted-foreground">by Cuadrado Zayas Infrastructure</span></span>
        </NavLink>
        <nav aria-label="Primary">
          <ul className="flex flex-wrap items-center gap-1">
            {landing && [['#platform', 'Workspace'], ['#workflow', 'Workflow'], ['#questions', 'FAQ']].map(([href, label]) => <li key={href}><a href={href} className="inline-flex min-h-control items-center px-2 text-sm font-medium hover:bg-muted">{label}</a></li>)}
            {links.map((link) => (
              <li key={link.to}>
                <NavLink
                  to={link.to}
                  end={link.end}
                  className={({ isActive }) =>
                    cn(
                      'inline-flex min-h-control items-center border-b-2 px-2 text-sm font-medium hover:bg-muted',
                      isActive ? 'border-primary text-primary' : 'border-transparent text-foreground',
                    )
                  }
                >
                  {link.label}
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>
        <AccountMenu />
      </div>
    </header>
  );
}
