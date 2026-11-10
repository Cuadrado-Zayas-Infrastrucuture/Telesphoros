/** The public landing page lives in the telesphoros-site project. The deployed app keeps no second copy to drift from it. */
export const PUBLIC_SITE_URL = 'https://telesphoros.app/';

const STAGING_APP_HOST = 'app.staging.telesphoros.app';

/**
 * True when the app is served from one of its own subdomains. Local work, the browser tests and the Vercel design preview are served
 * from other hosts and keep the in-app home page.
 */
export function usesPublicLanding(hostname = location.hostname): boolean {
  return hostname.endsWith('.telesphoros.app');
}

/**
 * Staging sends a signed-out visitor to its own sign-in page, never to the live site: staging must not depend on production, and the
 * staging landing (landing.staging.telesphoros.app) is behind Vercel's login, which invited testers cannot pass.
 */
export function isStagingApp(hostname = location.hostname): boolean {
  return hostname === STAGING_APP_HOST;
}

/** `replace`, so the Back button does not bounce the visitor straight back here and out again. */
export function goToPublicSite(): void {
  window.location.replace(PUBLIC_SITE_URL);
}
