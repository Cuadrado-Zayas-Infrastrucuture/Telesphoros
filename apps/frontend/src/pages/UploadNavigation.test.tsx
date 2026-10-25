import { StrictMode } from 'react';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { webcrypto } from 'node:crypto';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { AuthProvider } from '@/auth/AuthProvider';
import AuthCallbackPage from '@/pages/AuthCallbackPage';
import UploadReportPage from '@/pages/UploadReportPage';
import { fakeClient } from '@/test/authTestUtils';

afterEach(() => {
  sessionStorage.clear();
  vi.unstubAllGlobals();
});

it.each(['response', 'body'] as const)('navigation retires an older upload while its registration %s is pending', async (phase) => {
  vi.stubGlobal('crypto', webcrypto);
  // This control also runs in the disposable F06 composition, which writes scoped v2 metadata.
  const stored = () => {
    const records = ['telesphoros.upload-recovery.v1', 'telesphoros.upload-recovery.v2'].map((key) => sessionStorage.getItem(key)).filter((value) => value !== null);
    expect(records).toHaveLength(1);
    return JSON.parse(records[0]!);
  };
  const patientId = '11111111-1111-4111-8111-111111111111';
  const oldId = '22222222-2222-4222-8222-222222222222';
  const newId = '33333333-3333-4333-8333-333333333333';
  const now = '2026-10-15T12:00:00.000Z';
  let release!: () => void;
  let oldReached!: () => void;
  let oldRequestSignal: AbortSignal | undefined;
  const reached = new Promise<void>((resolve) => {
    oldReached = resolve;
  });
  const report = (id: string, name: string) => ({
    id,
    patientId,
    type: 'structured',
    filename: name,
    sizeBytes: 1,
    status: 'received',
    fileUploaded: false,
    contentType: null,
    sha256: null,
    createdAt: now,
    updatedAt: now,
  });
  const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
  const api = vi.fn<typeof fetch>(async (input, init) => {
    const path = new URL(String(input)).pathname;
    if (path === '/api/v1/me') return response({ roles: ['clinician'] });
    if (path === '/api/v1/me/recovery-scope') return response({ recoveryScope: 'a'.repeat(64) });
    if (path === '/api/v1/patients')
      return response({ data: [{ id: patientId, label: 'SYN-READONLY', createdAt: now, updatedAt: now }], meta: { page: 1, pageSize: 20, total: 1, totalPages: 1 } });
    if (path === '/api/v1/reports' && init?.method === 'POST') {
      const name = JSON.parse(String(init.body)).filename;
      if (name === 'earlier-synthetic.json') {
        oldRequestSignal = init?.signal as AbortSignal;
        const reply = response(report(oldId, name));
        if (phase === 'body') {
          reply.json = () => {
            oldReached();
            return new Promise((resolve) => {
              release = () => resolve(report(oldId, name));
            });
          };
          return reply;
        }
        oldReached();
        return new Promise<Response>((resolve) => {
          release = () => resolve(reply);
        });
      }
      return response(report(newId, name));
    }
    // Keep the newer upload's recovery entry rather than completing it.
    if (path.endsWith('/upload-state')) return response({}, 500);
    throw new Error('Unexpected synthetic request ' + path);
  });
  const router = createMemoryRouter(
    [
      { path: '/auth/callback', element: <AuthCallbackPage /> },
      {
        path: '/upload',
        element: (
          <StrictMode>
            <UploadReportPage />
          </StrictMode>
        ),
      },
      { path: '/away', element: <h1>Away</h1> },
    ],
    { initialEntries: ['/auth/callback'] },
  );
  render(
    <AuthProvider client={fakeClient({ returnTo: '/upload' })} apiBaseUrl="http://api.test" fetchImpl={api}>
      <RouterProvider router={router} />
    </AuthProvider>,
  );
  const user = userEvent.setup();
  async function submit(name: string) {
    await screen.findByRole('option', { name: 'SYN-READONLY' });
    await user.selectOptions(screen.getByLabelText(/synthetic patient \(required\)/i), patientId);
    await user.selectOptions(screen.getByLabelText(/report type/i), 'structured');
    const file = new File(['x'], name, { type: 'application/json' });
    Object.defineProperty(file, 'arrayBuffer', { value: async () => new TextEncoder().encode('x').buffer });
    await user.upload(screen.getByLabelText(/report file/i), file);
    await user.click(screen.getByLabelText(/synthetic data only/i));
    await user.click(screen.getByRole('button', { name: 'Upload report' }));
  }
  await submit('earlier-synthetic.json');
  await reached;
  await act(async () => {
    await router.navigate('/away');
  });
  await screen.findByRole('heading', { name: 'Away' });
  expect(oldRequestSignal?.aborted).toBe(false);
  await act(async () => {
    await router.navigate('/upload');
  });
  await submit('current-synthetic.json');
  await waitFor(() => expect(stored().reportId).toBe(newId));
  expect(api.mock.calls.filter(([url]) => String(url).endsWith('/api/v1/me'))).toHaveLength(1);
  await act(async () => {
    release();
  });
  expect(stored().reportId).toBe(newId);
});
