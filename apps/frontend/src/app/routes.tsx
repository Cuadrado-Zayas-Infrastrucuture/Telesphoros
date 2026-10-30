import { ownedStorageMode } from '@/lib/storageMode';
import type { RouteObject } from 'react-router-dom';
import { ProtectedRoute } from '@/auth/ProtectedRoute';
import { RequireRole } from '@/auth/RequireRole';
import { ADMIN_ROLES, CLINICAL_READ_ROLES, WRITER_ROLES } from '@/auth/roles';
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
          // Administrators only: the organization's own counts. Nothing clinical, so admin needs no clinical role for it.
          {
            element: <RequireRole anyOf={ADMIN_ROLES} />,
            children: [{ path: 'usage', lazy: async () => ({ Component: (await import('@/pages/UsagePage')).default }) }],
          },
          ...(import.meta.env.DEV
            ? [
                { path: 'local-interpretation', lazy: async () => ({ Component: (await import('@/pages/LocalInterpretationPage')).default }) },
                // specs/016: the whole flow on one screen; brings its own bar, so AppLayout drops the header, sidebar and footer here.
                { path: 'local-workspace', lazy: async () => ({ Component: (await import('@/pages/LocalWorkspacePage')).default }) },
                { path: 'local-upload', lazy: async () => ({ Component: (await import('@/pages/LocalUploadReportPage')).default }) },
                { path: 'local-review', lazy: async () => ({ Component: (await import('@/pages/LocalReviewPage')).default }) },
                { path: 'local-operations', lazy: async () => ({ Component: (await import('@/pages/LocalOperationsPage')).default }) },
              ]
            : []),
          // Spec 019 D02a: a test-only page of synthetic result ids, in the e2e build (`vite build --mode e2e`) alone. Vite replaces MODE at build time, so
          // a production build has no route and no chunk for it (scripts/check-chunks.mjs checks the route, scripts/check-foundation.mjs the chunk).
          ...(import.meta.env.MODE === 'e2e'
            ? [
                {
                  element: <RequireRole anyOf={CLINICAL_READ_ROLES} />,
                  children: [{ path: 'e2e/result-acknowledgements', lazy: async () => ({ Component: (await import('@/pages/ResultAcknowledgementsTestPage')).default }) }],
                },
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
