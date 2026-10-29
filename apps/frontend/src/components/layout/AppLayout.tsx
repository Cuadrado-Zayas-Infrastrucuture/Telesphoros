import { ownedStorageMode } from '@/lib/storageMode';
import { useRef } from 'react';
import { Outlet, useNavigation, useLocation } from 'react-router-dom';
import { SiteFooter } from '@/components/layout/SiteFooter';
import { useAuth } from '@/auth/AuthProvider';
import { WorkspaceSidebar } from '@/components/layout/WorkspaceSidebar';
import { SiteHeader } from '@/components/layout/SiteHeader';
import { SkipLink } from '@/components/layout/SkipLink';
import { Spinner } from '@/components/ui/Spinner';
import { useRouteFocus } from '@/hooks/useRouteFocus';
import { ThemeProvider } from '@/theme/ThemeProvider';

const SIGN_IN_FLOW = ['/signin', '/auth/callback', '/signed-out'];

export function AppLayout() {
  const { pathname } = useLocation();
  const landing = pathname === '/' && !ownedStorageMode();
  const { status } = useAuth();
  // One frame for every signed-in page (specs/018-unified-sidebar); the public landing and the sign-in flow keep the site header.
  const sidebar = status === 'signedIn' && !landing && !SIGN_IN_FLOW.includes(pathname);
  const workspace = sidebar || pathname.startsWith('/reports') || pathname.startsWith('/local-') || (pathname === '/' && ownedStorageMode());
  const mainRef = useRef<HTMLElement>(null);
  const navigation = useNavigation();
  useRouteFocus(mainRef, landing);

  // The one-screen workspace (specs/016) is its own frame: no site header, sidebar or footer.
  if (pathname === '/local-workspace') {
    return (
      <ThemeProvider pathname={pathname}>
        <SkipLink />
        <main id="main" ref={mainRef} tabIndex={-1} className="focus:outline-none">
          <Outlet />
        </main>
      </ThemeProvider>
    );
  }

  return (
    <ThemeProvider pathname={pathname}>
      <div className={`flex min-h-dvh flex-col${workspace ? ' workspace-shell' : ''}${sidebar ? ' workspace-layout' : ''}`}>
        <SkipLink />
        {sidebar ? <WorkspaceSidebar /> : <SiteHeader />}
        <div className={sidebar ? 'workspace-body' : 'contents'}>
          {/* Announced politely while a lazy route's JavaScript is being fetched. */}
          <div role="status" aria-live="polite" className="mx-auto w-full max-w-page px-4 sm:px-6">
            {navigation.state === 'loading' && (
              <p className="flex items-center gap-2 py-2 text-sm text-muted-foreground">
                <Spinner /> Loading page…
              </p>
            )}
          </div>
          <main
            id="main"
            ref={mainRef}
            tabIndex={-1}
            className={
              sidebar
                ? 'workspace-main focus:outline-none'
                : landing
                  ? 'w-full flex-1 focus:outline-none'
                  : 'mx-auto w-full max-w-page flex-1 px-4 py-6 focus:outline-none sm:px-6 sm:py-10'
            }
          >
            <Outlet />
          </main>
          {!sidebar && <SiteFooter />}
        </div>
      </div>
    </ThemeProvider>
  );
}
