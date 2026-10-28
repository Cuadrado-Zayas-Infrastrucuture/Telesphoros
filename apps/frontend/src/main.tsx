import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, RouterProvider } from 'react-router-dom';
import { routes } from '@/app/routes';
import { AuthProvider } from '@/auth/AuthProvider';
import { AuthConfigError, loadAuthConfig } from '@/auth/authConfig';
import { createAuthClient } from '@/auth/authClient';
import { applyTheme, deviceQuery, readThemePreference, themeFor } from '@/lib/theme';
import '@/styles/index.css';

const root = createRoot(document.getElementById('root')!);

try {
  const config = loadAuthConfig(import.meta.env, window.location.origin, import.meta.env.MODE === 'production');
  // Before the first render, so a dark preference never opens on a light frame. ThemeProvider keeps it current afterwards.
  applyTheme(themeFor(window.location.pathname, readThemePreference(), deviceQuery()?.matches ?? false));
  const router = createBrowserRouter(routes);
  root.render(
    <StrictMode>
      <AuthProvider client={createAuthClient(config)} apiBaseUrl={config.apiBaseUrl}>
        <RouterProvider router={router} />
      </AuthProvider>
    </StrictMode>,
  );
} catch (error) {
  // A bad build configuration: say so plainly instead of showing a blank page. No stack trace.
  const message = error instanceof AuthConfigError ? error.message : 'The application could not start.';
  root.render(
    <main style={{ fontFamily: 'var(--font-family-sans)', padding: '2rem', maxWidth: '40rem' }}>
      <h1>Telesphoros cannot start</h1>
      <p role="alert">{message}</p>
    </main>,
  );
}
