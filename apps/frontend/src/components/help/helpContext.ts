import { HELP_SCREENS, type HelpArticle, type HelpScreen } from '@telesphoros/help-content';

const TOTAL_SCREEN_COUNT = Object.keys(HELP_SCREENS).length;

/** Maps the current React Router pathname to a Spec 051 HelpScreen id, or null on routes with no screen id. */
export function helpScreenForPath(pathname: string): HelpScreen | null {
  const clean = pathname.replace(/\/+$/, '') || '/';
  if (clean === '/workspace') return 'worklist';
  if (clean === '/chat') return 'chat';
  if (clean === '/patients') return 'patients';
  if (clean === '/patients/new') return 'new-patient';
  if (/^\/patients\/[^/]+$/.test(clean)) return 'patient';
  if (clean === '/reports' || clean.startsWith('/reports/')) return 'reports';
  if (clean === '/follow-ups') return 'follow-ups';
  if (clean === '/settings') return 'settings';
  if (clean === '/usage') return 'usage';
  return null;
}

/** True when at least one of the viewer's roles is permitted to see this article, or the article is for all roles. */
export function articleVisibleToRoles(article: HelpArticle, roles: readonly string[]): boolean {
  if (article.roles === 'all') return true;
  return article.roles.some((role) => roles.includes(role));
}

/** All articles this viewer's roles are permitted to read, in their canonical order. */
export function visibleArticlesForRoles(articles: readonly HelpArticle[], roles: readonly string[]): HelpArticle[] {
  return articles.filter((article) => articleVisibleToRoles(article, roles));
}

/**
 * Articles for the current screen and viewer roles: screen-specific articles appear first, followed by universal
 * articles that apply to every screen, preserving canonical order within each group.
 */
export function articlesForContext(articles: readonly HelpArticle[], screen: HelpScreen | null, roles: readonly string[]): HelpArticle[] {
  const visible = visibleArticlesForRoles(articles, roles);
  if (screen === null) return visible;
  const onScreen = visible.filter((article) => article.screens.includes(screen));
  const specific = onScreen.filter((article) => article.screens.length < TOTAL_SCREEN_COUNT);
  const universal = onScreen.filter((article) => article.screens.length >= TOTAL_SCREEN_COUNT);
  return [...specific, ...universal];
}
