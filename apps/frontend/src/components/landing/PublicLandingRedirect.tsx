import { useEffect } from 'react';
import { RouteLoading } from '@/components/RouteLoading';
import { goToPublicSite } from '@/lib/landing/public-site';

/** Leaves the app for the public landing page. The loading layout holds the screen until the browser has moved. */
export function PublicLandingRedirect() {
  useEffect(() => goToPublicSite(), []);
  return <RouteLoading />;
}
