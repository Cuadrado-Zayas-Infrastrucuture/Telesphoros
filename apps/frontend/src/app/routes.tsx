import { ownedStorageMode } from '@/lib/storageMode';
import type { RouteObject } from 'react-router-dom';
import { ProtectedRoute } from '@/auth/ProtectedRoute';
import { RequireRole } from '@/auth/RequireRole';
import { CLINICAL_READ_ROLES, WRITER_ROLES } from '@/auth/roles';
import { AppLayout } from '@/components/layout/AppLayout';
import { RouteError } from '@/components/RouteError';

/**
 * Every page is a lazy import, so each route ships as its own JavaScript chunk and the
 * browser only downloads the page being visited. scripts/check-chunks.mjs enforces this.
 *
 * Public: overview, sign-in, the sign-in callback, signed-out, not-found.
 * Signed-in only: everything under <ProtectedRoute>; and by role: under <RequireRole>.
 */
// Read once at start-up so an invalid owned-storage setting fails here, before anything renders, rather than being taken for "off".
ownedStorageMode();

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
          // Every signed-in member, including one with no role: it shows their own account, roles and session, nothing clinical.
          { path: 'settings', lazy: async () => ({ Component: (await import('@/pages/SettingsPage')).default }) },
          // Every build: the API authorizes each read. Only file download is owned-storage only (ReportsPage).
          {
            element: <RequireRole anyOf={CLINICAL_READ_ROLES} />,
            children: [{ path: 'reports', lazy: async () => ({ Component: (await import('@/pages/ReportsPage')).default }) }],
          },
          ...(import.meta.env.DEV
            ? [
                { path: 'local-interpretation', lazy: async () => ({ Component: (await import('@/pages/LocalInterpretationPage')).default }) },
                { path: 'local-upload', lazy: async () => ({ Component: (await import('@/pages/LocalUploadReportPage')).default }) },
                { path: 'local-review', lazy: async () => ({ Component: (await import('@/pages/LocalReviewPage')).default }) },
                { path: 'local-operations', lazy: async () => ({ Component: (await import('@/pages/LocalOperationsPage')).default }) },
              ]
            : []),
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
