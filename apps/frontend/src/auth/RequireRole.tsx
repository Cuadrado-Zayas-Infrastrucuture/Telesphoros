import type { Role } from '@telesphoros/shared-types';
import { Outlet } from 'react-router-dom';
import { lazy, Suspense } from 'react';
const ForbiddenPage = lazy(() => import('@/pages/ForbiddenPage'));
import { useAuth } from './AuthProvider';

/**
 * Shows the page only to users holding one of the roles. This is a courtesy to the user: the API
 * refuses the same requests regardless, so removing this check would hide nothing from an attacker.
 */
export function RequireRole({ anyOf }: { anyOf: readonly Role[] }) {
  const { roles } = useAuth();
  return roles.some((role) => anyOf.includes(role)) ? (
    <Outlet />
  ) : (
    <Suspense fallback={<p role="status">Loading page…</p>}>
      <ForbiddenPage />
    </Suspense>
  );
}
