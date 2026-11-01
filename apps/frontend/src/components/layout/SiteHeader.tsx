import productMark from '@/assets/telesphoros-shield-rx.png';
import { ownedStorageMode } from '@/lib/storageMode';
import { NavLink, useLocation } from 'react-router-dom';
import { useAuth } from '@/auth/AuthProvider';
import { ADMIN_ROLES, CLINICAL_READ_ROLES, WRITER_ROLES } from '@/auth/roles';
import { AccountMenu } from '@/components/layout/AccountMenu';
import { cn } from '@/lib/utils';
import { useLandingRoute, useShellCopy } from '@/lib/landing/landing-language';
import { LanguageToggle } from '@/components/landing/LanguageToggle';

export function SiteHeader() {
  const pathname = useLocation().pathname;
  const landing = useLandingRoute();
  const { status, roles } = useAuth();
  // The shell is Spanish only while the landing shows and Spanish is chosen; every other page stays English.
  const { header: h } = useShellCopy();
  // Links to pages the user cannot use are simply not shown. The pages are guarded as well.
  const links = [
    { to: '/', label: 'Overview', end: true, show: !landing },
    // The page needs a clinical-read role (routes.tsx), so an administrator alone is not offered a link that ends in "forbidden".
    { to: '/reports', label: 'Reports', end: true, show: roles.some((r) => CLINICAL_READ_ROLES.includes(r)) },
    ...(import.meta.env.DEV && location.hostname === '127.0.0.1' && ownedStorageMode() && roles.length > 0 && pathname !== '/reports'
      ? [{ to: '/local-interpretation', label: 'AI preview', end: true, show: true }]
      : []),
    { to: '/reports/upload', label: 'Upload report', end: false, show: !ownedStorageMode() && roles.some((r) => WRITER_ROLES.includes(r)) },
    { to: '/usage', label: 'Usage', end: true, show: !landing && roles.some((r) => ADMIN_ROLES.includes(r)) },
    { to: '/settings', label: 'Settings', end: true, show: !landing && status === 'signedIn' },
  ].filter((link) => link.show);

  return (
    <header className={cn('border-b border-divider', landing ? 'landing-site-header bg-background' : 'bg-band')}>
      <div className="mx-auto flex max-w-page flex-wrap items-center justify-between gap-x-6 gap-y-3 px-4 py-4 sm:px-6">
        <NavLink to="/" className="inline-flex min-h-control min-w-0 max-w-full items-center gap-3 rounded-sm text-foreground">
          <img src={productMark} alt={h.logoAlt} width="64" height="66" loading="eager" className="brand-mark h-auto w-16 shrink-0" />
          <span className="flex min-w-0 flex-col wrap-anywhere">
            <span className="font-heading text-2xl font-semibold tracking-tight">Telesphoros</span>
            <span className="text-xs text-muted-foreground">{h.byline}</span>
          </span>
        </NavLink>
        <nav aria-label={h.nav}>
          <ul className="flex flex-wrap items-center gap-1">
            {landing &&
              [
                ['#platform', h.features],
                ['#questions', h.faq],
              ].map(([href, label]) => (
                <li key={href}>
                  <a href={href} className="inline-flex min-h-control items-center px-2 text-sm font-medium hover:bg-muted">
                    {label}
                  </a>
                </li>
              ))}
            {landing && (
              <li>
                <LanguageToggle />
              </li>
            )}
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
            {import.meta.env.DEV && location.hostname === '127.0.0.1' && ownedStorageMode() && roles.length > 0 && pathname === '/reports' && (
              <li>
                <a
                  href="#ai-assistant"
                  className="inline-flex min-h-control items-center border-b-2 border-transparent px-2 text-sm font-medium text-foreground hover:bg-muted"
                  onClick={(event) => {
                    const panel = document.getElementById('ai-assistant') as HTMLDetailsElement | null;
                    if (panel) {
                      event.preventDefault();
                      panel.open = true;
                      panel.scrollIntoView?.({ block: 'start' });
                      panel.querySelector('summary')?.focus({ preventScroll: true });
                    }
                  }}
                >
                  AI preview
                </a>
              </li>
            )}
          </ul>
        </nav>
        <AccountMenu />
      </div>
    </header>
  );
}
