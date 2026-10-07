import type { RouteObject } from 'react-router-dom';
import { ProtectedRoute } from '@/auth/ProtectedRoute';
import { RequireRole } from '@/auth/RequireRole';
import { WRITER_ROLES } from '@/auth/roles';
import { AppLayout } from '@/components/layout/AppLayout';
import { RouteError } from '@/components/RouteError';

/**
 * Every page is a lazy import, so each route ships as its own JavaScript chunk and the
 * browser only downloads the page being visited. scripts/check-chunks.mjs enforces this.
 *
 * Public: overview, sign-in, the sign-in callback, signed-out, not-found.
 * Signed-in only: everything under <ProtectedRoute>; and by role: under <RequireRole>.
 */
export const routes: RouteObject[] = [
  {
    element: <AppLayout />,
    errorElement: <RouteError />,
    children: [
      { index: true, lazy: async () => ({ Component: (await import('@/pages/HomePage')).default }) },
      { path: 'signin', lazy: async () => ({ Component: (await import('@/pages/SignInPage')).default }) },
      { path: 'auth/callback', lazy: async () => ({ Component: (await import('@/pages/AuthCallbackPage')).default }) },
      { path: 'signed-out', lazy: async () => ({ Component: (await import('@/pages/SignedOutPage')).default }) },
      {
        element: <ProtectedRoute />,
        children: [
          {
            element: <RequireRole anyOf={WRITER_ROLES} />,
            children: [
              {
                path: 'reports/upload',
                lazy: async () => ({ Component: (await import('@/pages/UploadReportPage')).default }),
              },
            ],
          },
        ],
      },
      { path: '*', lazy: async () => ({ Component: (await import('@/pages/NotFoundPage')).default }) },
    ],
  },
];
