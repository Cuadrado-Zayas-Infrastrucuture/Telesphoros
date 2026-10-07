import type { RouteObject } from 'react-router-dom';
import { AppLayout } from '@/components/layout/AppLayout';
import { RouteError } from '@/components/RouteError';

/**
 * Every page is a lazy import, so each route ships as its own JavaScript chunk and the
 * browser only downloads the page being visited. scripts/check-chunks.mjs enforces this.
 */
export const routes: RouteObject[] = [
  {
    element: <AppLayout />,
    errorElement: <RouteError />,
    children: [
      { index: true, lazy: async () => ({ Component: (await import('@/pages/HomePage')).default }) },
      {
        path: 'reports/upload',
        lazy: async () => ({ Component: (await import('@/pages/UploadReportPage')).default }),
      },
      { path: '*', lazy: async () => ({ Component: (await import('@/pages/NotFoundPage')).default }) },
    ],
  },
];
