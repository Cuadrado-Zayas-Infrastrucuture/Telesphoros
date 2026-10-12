import { ownedStorageMode } from '@/lib/storageMode';
import { NavLink } from 'react-router-dom';
import { useAuth } from '@/auth/AuthProvider';
import { WRITER_ROLES } from '@/auth/roles';
import { AccountMenu } from '@/components/layout/AccountMenu';
import { cn } from '@/lib/utils';

export function SiteHeader() {
  const { roles } = useAuth();
  // Links to pages the user cannot use are simply not shown. The pages are guarded as well.
  const links = [
    { to: '/reports', label: 'Reports', end: true, show: ownedStorageMode() && roles.length > 0 },
    { to: '/', label: 'Overview', end: true, show: true },
    { to: '/reports/upload', label: 'Upload report', end: false, show: roles.some((r) => WRITER_ROLES.includes(r)) },
  ].filter((link) => link.show);

  return (
    <header className="border-b border-divider bg-background">
      <div className="mx-auto flex max-w-page flex-wrap items-center justify-between gap-x-6 gap-y-2 px-4 py-3 sm:px-6">
        <NavLink to="/" className="inline-flex h-control items-center rounded-sm text-lg font-semibold text-foreground">
          Telesphoros{' '}
          <span className="text-primary">Remastered</span>
        </NavLink>
        <nav aria-label="Primary">
          <ul className="flex items-center gap-1">
            {links.map((link) => (
              <li key={link.to}>
                <NavLink
                  to={link.to}
                  end={link.end}
                  className={({ isActive }) =>
                    cn(
                      'inline-flex h-control items-center rounded-md px-3 text-base font-medium hover:bg-muted',
                      isActive ? 'bg-muted text-primary underline underline-offset-4' : 'text-foreground',
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
