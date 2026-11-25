import { ownedStorageMode, syntheticStagingMode } from '@/lib/storageMode';
import { languagePreviewEnabled } from '@/lib/languagePreview';
import type { RouteObject } from 'react-router-dom';
import { ProtectedRoute } from '@/auth/ProtectedRoute';
import { RequireRole } from '@/auth/RequireRole';
import { ADMIN_ROLES, CLINICAL_READ_ROLES, FOLLOWUP_READ_ROLES, WRITER_ROLES } from '@/auth/roles';
import { AppLayout } from '@/components/layout/AppLayout';
import { RouteError } from '@/components/RouteError';
import { RouteLoading } from '@/components/RouteLoading';

/**
 * Every page is a lazy import, so each route ships as its own JavaScript chunk and the
 * browser only downloads the page being visited. scripts/check-chunks.mjs enforces this.
 *
 * Public: overview, sign-in, the sign-in callback, signed-out, not-found.
 * Signed-in only: everything under <ProtectedRoute>; and by role: under <RequireRole>.
 *
 * `handle.screen` names a screen for the language layer (spec 050 LS1-D2, `lib/words/screens.ts`). A route with none is not translated.
 */
// Read once at start-up so an invalid owned-storage setting fails here, before anything renders, rather than being taken for "off".
ownedStorageMode();
syntheticStagingMode();
languagePreviewEnabled();

export const routes: RouteObject[] = [
  {
    element: <AppLayout />,
    errorElement: <RouteError />,
    // The first load of a lazy page: without it the router renders null in place of the whole app until the chunk arrives.
    HydrateFallback: RouteLoading,
    children: [
      { index: true, lazy: async () => ({ Component: (await import('@/pages/HomePage')).default }) },
      { path: 'signin', handle: { screen: 'sign-in' }, lazy: async () => ({ Component: (await import('@/pages/SignInPage')).default }) },
      { path: 'auth/callback', handle: { screen: 'sign-in' }, lazy: async () => ({ Component: (await import('@/pages/AuthCallbackPage')).default }) },
      { path: 'signed-out', handle: { screen: 'sign-in' }, lazy: async () => ({ Component: (await import('@/pages/SignedOutPage')).default }) },
      {
        element: <ProtectedRoute />,
        children: [
          // The signed-in frame, in every build, for any signed-in member: it keeps the chat (specs/024) in memory while other pages are visited.
          // Spec 049: the home at /workspace is the worklist, and the chat has its own address, /chat, until the help assistant replaces it (W-D2).
          {
            lazy: async () => ({ Component: (await import('@/pages/WorkspacePage')).default }),
            children: [
              { path: 'workspace', handle: { screen: 'home' }, lazy: async () => ({ Component: (await import('@/pages/WorklistPage')).default }) },
              { path: 'chat', element: null },
              // Every signed-in member, including one with no role: it shows their own account, roles and session, nothing clinical.
              { path: 'settings', lazy: async () => ({ Component: (await import('@/pages/SettingsPage')).default }) },
              // Every build: the API authorizes each read. Only file download is owned-storage only (ReportsPage).
              {
                element: <RequireRole anyOf={CLINICAL_READ_ROLES} />,
                children: [{ path: 'reports', lazy: async () => ({ Component: (await import('@/pages/ReportsPage')).default }) }],
              },
              // Specs/041 C2: the clinic's follow-ups as a page, for the roles that read them (it was a sidebar drawer).
              {
                element: <RequireRole anyOf={FOLLOWUP_READ_ROLES} />,
                children: [{ path: 'follow-ups', lazy: async () => ({ Component: (await import('@/pages/FollowupsPage')).default }) }],
              },
              {
                element: <RequireRole anyOf={WRITER_ROLES} />,
                children: [
                  {
                    path: 'reports/upload',
                    lazy: async () => ({ Component: (await import('@/pages/UploadReportPage')).default }),
                  },
                ],
              },
              {
                element: <RequireRole anyOf={WRITER_ROLES} />,
                children: [{ path: 'patients/new', lazy: async () => ({ Component: (await import('@/pages/NewPatientPage')).default }) }],
              },
              {
                element: <RequireRole anyOf={CLINICAL_READ_ROLES} />,
                children: [
                  // Specs/034: the sidebar's Patients destination, the list the panel used to hold.
                  { path: 'patients', lazy: async () => ({ Component: (await import('@/pages/PatientsPage')).default }) },
                  { path: 'patients/:id', handle: { screen: 'patient' }, lazy: async () => ({ Component: (await import('@/pages/PatientPage')).default }) },
                ],
              },
            ],
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
        ],
      },
      { path: '*', lazy: async () => ({ Component: (await import('@/pages/NotFoundPage')).default }) },
    ],
  },
];
