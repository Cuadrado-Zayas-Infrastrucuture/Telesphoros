import { ownedStorageMode } from '@/lib/storageMode';
import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { Outlet, useMatches, useNavigation, useLocation } from 'react-router-dom';
import type { UIMatch } from 'react-router-dom';
import { SiteFooter } from '@/components/layout/SiteFooter';
import { useAuth } from '@/auth/AuthProvider';
import { WorkspaceSidebar } from '@/components/layout/WorkspaceSidebar';

const HelpDrawer = lazy(() => import('@/components/help/HelpDrawer').then((module) => ({ default: module.HelpDrawer })));
import { SiteHeader } from '@/components/layout/SiteHeader';
import { SkipLink } from '@/components/layout/SkipLink';
import { ScreenLanguage } from '@/components/layout/ScreenLanguage';
import { ContentSkeleton } from '@/components/ui/ContentSkeleton';
import { useRouteFocus } from '@/hooks/useRouteFocus';
import { useAppLanguage } from '@/lib/appLanguage';
import { useLandingLanguage } from '@/lib/landing/landing-language';
import { SIGN_IN_FLOW } from '@/lib/theme';
import { ScreenLanguageContext, screenLanguage, wordsIn, type Screen } from '@/lib/words/screens';
import { FRAME_WORDS } from '@/lib/words/shell';
import { ThemeProvider } from '@/theme/ThemeProvider';

/** The screen the deepest matched route names in `handle.screen`, if any. */
function namedScreen(matches: readonly UIMatch[]): Screen | undefined {
  for (let i = matches.length - 1; i >= 0; i--) {
    const named = (matches[i]?.handle as { screen?: Screen } | undefined)?.screen;
    if (named) return named;
  }
  return undefined;
}

export function AppFrame() {
  const { pathname } = useLocation();
  const landing = pathname === '/' && !ownedStorageMode();
  const { status } = useAuth();
  // One frame for every signed-in page (specs/018-unified-sidebar); the public landing and the sign-in flow keep the site header.
  const sidebar = status === 'signedIn' && !landing && !SIGN_IN_FLOW.includes(pathname);
  const workspace = sidebar || pathname.startsWith('/reports') || pathname.startsWith('/local-') || (pathname === '/' && ownedStorageMode());
  const mainRef = useRef<HTMLElement>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const [helpMounted, setHelpMounted] = useState(false);
  const [prevSidebar, setPrevSidebar] = useState(sidebar);
  if (prevSidebar !== sidebar) {
    setPrevSidebar(sidebar);
    if (!sidebar && helpOpen) setHelpOpen(false);
  }
  const drawerOpen = sidebar && helpOpen;
  const openHelp = () => {
    setHelpMounted(true);
    setHelpOpen(true);
  };
  const navigation = useNavigation();
  useRouteFocus(mainRef, landing);
  // Spec 050 LS1 (LS1-D1): the one place that sets <html lang>. The landing has its own language; every other page follows the app's (R3).
  const { language: app } = useAppLanguage();
  const { language: landingLanguage } = useLandingLanguage();
  // A layout effect, so the attribute is set in the same commit as the content it describes, before the page is shown.
  useLayoutEffect(() => {
    document.documentElement.lang = landing ? landingLanguage : app;
  }, [landing, landingLanguage, app]);
  // The screen a route names in `handle.screen` (LS1-D2); a route with none is not translated (R6). The frame itself is the `shell`. The landing
  // keeps its own language and copy, so neither the shell's nor a screen's language is marked there.
  const screen = namedScreen(useMatches());
  const shell = screenLanguage(app, 'shell');
  // The frame provides the shell's language, so it reads its own words for it directly rather than through `useWords`.
  const frameWords = wordsIn(FRAME_WORDS, shell.language);

  // The one-screen workspace (specs/016) is its own frame: no site header, sidebar or footer.
  if (pathname === '/local-workspace') {
    return (
      <ThemeProvider pathname={pathname}>
        <SkipLink />
        <ScreenLanguage screen={screen}>
          {(lang) => (
            <main id="main" ref={mainRef} tabIndex={-1} lang={lang} className="focus:outline-none">
              <Outlet />
            </main>
          )}
        </ScreenLanguage>
      </ThemeProvider>
    );
  }

  return (
    <ThemeProvider pathname={pathname}>
      <ScreenLanguageContext.Provider value={shell}>
        <div
          className={`app-frame flex flex-col${workspace ? ' workspace-shell' : ''}${sidebar ? ' workspace-layout' : ''}`}
          lang={!landing && shell.language !== app ? shell.language : undefined}
        >
          <SkipLink />
          {sidebar ? <WorkspaceSidebar helpOpen={drawerOpen} onOpenHelp={openHelp} /> : <SiteHeader />}
          <div className={sidebar ? 'workspace-body' : 'contents'}>
            {/* Announced politely while a lazy route's JavaScript is being fetched. */}
            <div role="status" aria-live="polite" className="mx-auto w-full max-w-page px-4 sm:px-6">
              {navigation.state === 'loading' && <p className="sr-only">{frameWords.loadingPage}</p>}
            </div>
            <ScreenLanguage screen={screen} inherits={shell.language}>
              {(lang) => (
                <main
                  id="main"
                  ref={mainRef}
                  tabIndex={-1}
                  aria-busy={navigation.state === 'loading' || undefined}
                  lang={landing ? undefined : lang}
                  className={
                    sidebar
                      ? `workspace-main relative focus:outline-none${navigation.state === 'loading' ? ' route-pending' : ''}`
                      : landing
                        ? `relative w-full flex-1 focus:outline-none${navigation.state === 'loading' ? ' route-pending' : ''}`
                        : `relative mx-auto w-full max-w-page flex-1 px-4 py-6 focus:outline-none sm:px-6 sm:py-10${navigation.state === 'loading' ? ' route-pending' : ''}`
                  }
                >
                  {navigation.state === 'loading' && (
                    <div className="route-skeleton absolute inset-0 z-10 bg-background p-4 sm:p-6">
                      <ContentSkeleton label="" variant="page" />
                    </div>
                  )}
                  <Outlet />
                </main>
              )}
            </ScreenLanguage>
            {!sidebar && <SiteFooter />}
          </div>
          {sidebar && helpMounted && (
            <Suspense fallback={null}>
              <HelpDrawer open={drawerOpen} onClose={() => setHelpOpen(false)} />
            </Suspense>
          )}
        </div>
      </ScreenLanguageContext.Provider>
    </ThemeProvider>
  );
}
