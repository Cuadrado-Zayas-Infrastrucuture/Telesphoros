import { render } from '@testing-library/react';
import type { Role } from '@telesphoros/shared-types';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { vi } from 'vitest';
import { routes } from '@/app/routes';
import { AuthProvider } from '@/auth/AuthProvider';
import type { AuthClient, Session } from '@/auth/authClient';

export const TOKEN = 'fake-access-token-for-tests';

export interface FakeClient extends AuthClient {
  signIn: ReturnType<typeof vi.fn<AuthClient['signIn']>>;
  completeSignIn: ReturnType<typeof vi.fn<AuthClient['completeSignIn']>>;
  signOut: ReturnType<typeof vi.fn<AuthClient['signOut']>>;
}

export function fakeClient(session: Partial<Session> = {}): FakeClient {
  return {
    signIn: vi.fn(async () => undefined),
    completeSignIn: vi.fn(async () => ({
      accessToken: TOKEN,
      expiresAt: Math.floor(Date.now() / 1000) + 900,
      returnTo: '/',
      ...session,
    })),
    signOut: vi.fn(async () => undefined),
  };
}

/** A `fetch` that answers GET /api/v1/me with the given roles (or a status). */
export function fakeFetch(answer: { roles?: unknown; status?: number } = { roles: ['clinician'] }) {
  return vi.fn<typeof fetch>(async (input) => {
    if (String(input).includes('/api/v1/patients')) return new Response(JSON.stringify({ data: [], meta: { page: 1, pageSize: 20, total: 0, totalPages: 0 } }));
    return new Response(JSON.stringify({ roles: answer.roles ?? [] }), {
      status: answer.status ?? 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });
}

export const API = 'http://api.test';

/**
 * Renders the real route table inside the real provider, with a fake identity client.
 * `signedInAs` completes a sign-in first (through /auth/callback, exactly as the browser would),
 * then lands on `path`.
 */
export function renderApp(path: string, options: { signedInAs?: Role[]; client?: FakeClient; fetchImpl?: typeof fetch } = {}) {
  const client = options.client ?? fakeClient({ returnTo: path });
  const fetchImpl = options.fetchImpl ?? (fakeFetch({ roles: options.signedInAs ?? [] }) as unknown as typeof fetch);
  const router = createMemoryRouter(routes, { initialEntries: [options.signedInAs ? '/auth/callback' : path] });
  const result = render(
    <AuthProvider client={client} apiBaseUrl={API} fetchImpl={fetchImpl}>
      <RouterProvider router={router} />
    </AuthProvider>,
  );
  return { ...result, client, router, fetchImpl: fetchImpl as unknown as ReturnType<typeof fakeFetch> };
}
