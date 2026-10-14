import { ownedStorageMode } from '@/lib/storageMode';
import { useRef } from 'react';
import { Outlet, useNavigation, useLocation } from 'react-router-dom';
import { SiteFooter } from '@/components/layout/SiteFooter';
import { SiteHeader } from '@/components/layout/SiteHeader';
import { SkipLink } from '@/components/layout/SkipLink';
import { Spinner } from '@/components/ui/Spinner';
import { useRouteFocus } from '@/hooks/useRouteFocus';

export function AppLayout() {
  const landing = useLocation().pathname === '/' && !ownedStorageMode();
  const mainRef = useRef<HTMLElement>(null);
  const navigation = useNavigation();
  useRouteFocus(mainRef, landing);

  return (
    <div className="flex min-h-dvh flex-col">
      <SkipLink />
      <SiteHeader />
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
        className={landing ? "w-full flex-1 focus:outline-none" : "mx-auto w-full max-w-page flex-1 px-4 py-6 focus:outline-none sm:px-6 sm:py-10"}
      >
        <Outlet />
      </main>
      <SiteFooter />
    </div>
  );
}
