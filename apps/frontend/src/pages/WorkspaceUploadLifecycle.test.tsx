import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { webcrypto } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { RECOVERY_SCOPE, renderApp } from '@/test/authTestUtils';
import { clearRecovery } from '@/lib/uploadRecovery';

// Exercise the real conversation, auth provider, upload orchestration and recovery store. Only the HTTP boundary is controlled.
const PATIENT_ID = '11111111-1111-4111-8111-111111111111';
const OLD_ID = '22222222-2222-4222-8222-222222222222';
const NEW_ID = '33333333-3333-4333-8333-333333333333';
const ATTEMPT_ID = '44444444-4444-4444-8444-444444444444';
const REVISION = '55555555-5555-4555-8555-555555555555';
const DATE = '2026-10-15T12:00:00.000Z';
const SHA = '2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881';
const RECOVERY_KEY = 'telesphoros.upload-recovery.v2';
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const page = (data: unknown[]) => ({ data, meta: { page: 1, pageSize: 20, total: data.length, totalPages: data.length ? 1 : 0 } });
const report = (id = OLD_ID, filename = 'earlier-synthetic.json', uploaded = false) => ({
  id,
  patientId: PATIENT_ID,
  type: 'structured',
  filename,
  sizeBytes: 1,
  status: 'received',
  fileUploaded: uploaded,
  contentType: uploaded ? 'application/json' : null,
  sha256: uploaded ? SHA : null,
  createdAt: DATE,
  updatedAt: DATE,
});
const attempt = (state: string) => ({ attemptId: ATTEMPT_ID, revision: REVISION, state, expiresAt: new Date(Date.now() + 300_000).toISOString() });
const stored = () => JSON.parse(sessionStorage.getItem(RECOVERY_KEY) ?? 'null');

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** All reports and identifiers are synthetic. Unknown requests fail closed rather than receiving a plausible response. */
function api(intercept: (path: string, init?: RequestInit) => Promise<Response | undefined>) {
  return vi.fn<typeof fetch>(async (input, init) => {
    const path = new URL(String(input)).pathname;
    const intercepted = await intercept(path, init);
    if (intercepted) return intercepted;
    if (path === '/api/v1/me') return response({ roles: ['clinician'] });
    if (path === '/api/v1/me/recovery-scope') return response({ recoveryScope: RECOVERY_SCOPE });
    if (path === '/api/v1/patients') return response(page([{ id: PATIENT_ID, label: 'SYN-READONLY', createdAt: DATE, updatedAt: DATE, mergedInto: null }]));
    if (path === '/api/v1/reports' && init?.method === 'POST') {
      const { filename } = JSON.parse(String(init.body));
      return response(report(filename === 'earlier-synthetic.json' ? OLD_ID : NEW_ID, filename));
    }
    if (path === '/api/v1/reports') return response(page([]));
    if (path.endsWith('/upload-state')) return response({ revision: REVISION, fileUploaded: false });
    if (path.endsWith('/upload-attempts')) return response(attempt('declared'));
    if (path === `/api/v1/reports/${OLD_ID}`) return response(report());
    throw new Error(`Unexpected synthetic request: ${init?.method ?? 'GET'} ${path}`);
  });
}

async function attach(name = 'earlier-synthetic.json') {
  await screen.findByRole('button', { name: 'Attach a report' });
  const file = new File(['x'], name, { type: 'application/json' });
  Object.defineProperty(file, 'arrayBuffer', { value: async () => new TextEncoder().encode('x').buffer });
  await userEvent.upload(document.querySelector<HTMLInputElement>('input[type=file]')!, file);
  await waitFor(() => expect(screen.getByRole('combobox', { name: 'Patient' })).toHaveValue(PATIENT_ID));
  await userEvent.click(screen.getByRole('checkbox', { name: 'I confirm this file contains synthetic data only' }));
}
const send = () => userEvent.click(screen.getByRole('button', { name: 'Upload report' }));
const newChat = () => userEvent.click(within(screen.getByRole('navigation', { name: 'Primary' })).getByRole('link', { name: 'New chat' }));
const details = () => within(screen.getByRole('dialog', { name: 'Report details' }));

beforeEach(() => {
  clearRecovery();
  vi.stubGlobal('crypto', webcrypto);
});
afterEach(() => {
  clearRecovery();
  vi.unstubAllGlobals();
});

it.each([
  ['cancelling', 'Cancellation is pending. Retry cancellation before starting over.'],
  ['offline', 'Cancellation could not be confirmed. Retry cancellation before starting over.'],
  ['refused', 'The file operation is unavailable. Your entries are kept; please retry.'],
  ['committed', 'The file was already stored. Check Reports before starting another upload.'],
])('Stop reports the actual %s cancellation outcome without claiming cancellation', async (outcome, message) => {
  const reached = deferred<void>();
  const cancellation = deferred<Response>();
  let transferSignal: AbortSignal | null | undefined;
  const fetchImpl = api(async (path, init) => {
    if (path.endsWith('/bytes')) {
      transferSignal = init?.signal;
      reached.resolve();
      return new Promise<Response>((_resolve, reject) => {
        transferSignal!.addEventListener('abort', () => reject(new DOMException('Synthetic transfer stopped', 'AbortError')), { once: true });
      });
    }
    if (path.endsWith('/cancel')) {
      if (outcome === 'offline') throw new Error('outside-response-not-for-display');
      return cancellation.promise;
    }
  });
  renderApp('/workspace', { signedInAs: ['clinician'], fetchImpl });
  await attach();
  await send();
  await reached.promise;
  const saved = stored();
  await userEvent.click(screen.getByRole('button', { name: 'Stop' }));
  expect(transferSignal?.aborted).toBe(true);
  if (outcome !== 'offline') {
    await waitFor(() => expect(fetchImpl.mock.calls.some(([url]) => String(url).endsWith('/cancel'))).toBe(true));
    expect(screen.queryByText('Upload cancelled.')).not.toBeInTheDocument();
    await act(async () => {
      cancellation.resolve(outcome === 'refused' ? response({}, 503) : response(attempt(outcome)));
    });
  }
  await screen.findByRole('dialog', { name: 'Report details' });
  await waitFor(() => expect(details().getByRole('alert')).toHaveTextContent(message));
  expect(screen.queryByText('Upload cancelled.')).not.toBeInTheDocument();
  expect(screen.queryByText('outside-response-not-for-display')).not.toBeInTheDocument();
  expect(details().getByRole('button', { name: 'Cancel upload' })).toBeEnabled();
  expect(fetchImpl.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(false);
  if (outcome === 'committed')
    expect(stored()).toBeNull(); // Server-established terminal state, not a browser cancellation.
  else expect(stored()).toMatchObject({ requestId: saved.requestId, reportId: OLD_ID, declaration: saved.declaration, attempt: { attemptId: ATTEMPT_ID } });
});

it.each(['cancelled', 'cleaned'])('Stop reports cancellation only after the server acknowledges %s', async (state) => {
  const reached = deferred<void>();
  const cancellation = deferred<Response>();
  const fetchImpl = api(async (path, init) => {
    if (path.endsWith('/bytes')) {
      reached.resolve();
      return new Promise<Response>((_resolve, reject) => {
        init!.signal!.addEventListener('abort', () => reject(new DOMException('Synthetic stop', 'AbortError')), { once: true });
      });
    }
    if (path.endsWith('/cancel')) return cancellation.promise;
  });
  renderApp('/workspace', { signedInAs: ['clinician'], fetchImpl });
  await attach();
  await send();
  await reached.promise;
  await userEvent.click(screen.getByRole('button', { name: 'Stop' }));
  await waitFor(() => expect(fetchImpl.mock.calls.some(([url]) => String(url).endsWith('/cancel'))).toBe(true));
  expect(screen.queryByText('Upload cancelled.')).not.toBeInTheDocument();
  expect(stored()).toMatchObject({ reportId: OLD_ID });
  await act(async () => {
    cancellation.resolve(response(attempt(state)));
  });
  await screen.findByRole('dialog', { name: 'Report details' });
  await waitFor(() => expect(details().getByRole('alert')).toHaveTextContent('Upload cancelled.'));
  expect(stored()).toBeNull();
});

it('keeps the original attempt through unconfirmed Stop and refuses fresh work until cancellation is acknowledged', async () => {
  const reached = deferred<void>();
  let cancelState = 'cancelling';
  const fetchImpl = api(async (path, init) => {
    if (path.endsWith('/bytes')) {
      reached.resolve();
      return new Promise<Response>((_resolve, reject) => {
        init!.signal!.addEventListener('abort', () => reject(new DOMException('Synthetic stop', 'AbortError')), { once: true });
      });
    }
    if (path.endsWith('/cancel')) return response(attempt(cancelState));
    if (path === `/api/v1/reports/${OLD_ID}` && init?.method === 'DELETE') return new Response(null, { status: 204 });
  });
  renderApp('/workspace', { signedInAs: ['clinician'], fetchImpl });
  await attach();
  await send();
  await reached.promise;
  const saved = stored();
  await userEvent.click(screen.getByRole('button', { name: 'Stop' }));
  await screen.findByRole('dialog', { name: 'Report details' });
  await waitFor(() => expect(details().getByRole('alert')).toHaveTextContent('Cancellation is pending.'));
  await attach('different-synthetic.json');
  await send();
  await screen.findByRole('dialog', { name: 'Report details' });
  await waitFor(() => expect(details().getByRole('alert')).toHaveTextContent('Cancellation is pending.'));
  expect(stored()).toMatchObject({ requestId: saved.requestId, reportId: OLD_ID, declaration: saved.declaration, attempt: { attemptId: ATTEMPT_ID } });
  expect(fetchImpl.mock.calls.filter(([url, init]) => String(url).endsWith('/api/v1/reports') && init?.method === 'POST')).toHaveLength(1);
  expect(fetchImpl.mock.calls.filter(([, init]) => init?.method === 'PUT')).toHaveLength(1);
  expect(fetchImpl.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(false);
  cancelState = 'cancelled';
  await userEvent.click(details().getByRole('button', { name: 'Cancel upload' }));
  expect(await screen.findByText('Upload cancelled and removed from your reports.')).toBeVisible();
  expect(stored()).toBeNull();
  for (const [url, init] of fetchImpl.mock.calls.filter(([url]) => String(url).endsWith('/cancel'))) {
    expect(String(url)).toBe(`http://api.test/api/v1/reports/${OLD_ID}/upload-attempts/${ATTEMPT_ID}/cancel`);
    expect(init?.headers).toMatchObject({ 'X-Upload-Revision': REVISION });
  }
});

it.each(['response', 'body'] as const)('New chat retires a pending registration %s before it can overwrite a newer recovery entry', async (phase) => {
  const reached = deferred<void>();
  const release = deferred<void>();
  const fetchImpl = api(async (path, init) => {
    if (path === '/api/v1/reports' && init?.method === 'POST' && JSON.parse(String(init.body)).filename === 'earlier-synthetic.json') {
      const reply = response(report());
      if (phase === 'body') {
        reply.json = async () => {
          reached.resolve();
          await release.promise;
          return report();
        };
      } else {
        reached.resolve();
        await release.promise;
      }
      return reply;
    }
    // Leave the newer report recoverable, without declaring or transmitting bytes.
    if (path.endsWith('/upload-state')) return response({}, 503);
  });
  renderApp('/workspace', { signedInAs: ['clinician'], fetchImpl });
  await attach();
  await send();
  await reached.promise;
  await newChat();
  await attach('current-synthetic.json');
  await send();
  await waitFor(() => expect(stored()).toMatchObject({ reportId: NEW_ID }));
  await waitFor(() => expect(details().getByRole('alert')).toHaveTextContent('The file operation is unavailable.'));
  const saved = sessionStorage.getItem(RECOVERY_KEY);
  await act(async () => {
    release.resolve();
  });
  expect(sessionStorage.getItem(RECOVERY_KEY)).toBe(saved);
  expect(fetchImpl.mock.calls.some(([url]) => String(url).includes(`/reports/${OLD_ID}/`))).toBe(false);
  expect(within(screen.getByRole('region', { name: 'Conversation' })).queryByText(/earlier-synthetic/)).not.toBeInTheDocument();
});

it('New chat aborts the old byte transfer, retains recovery, and never requests server cancellation implicitly', async () => {
  const reached = deferred<void>();
  let transferSignal: AbortSignal | null | undefined;
  const fetchImpl = api(async (path, init) => {
    if (path.endsWith('/bytes')) {
      transferSignal = init?.signal;
      reached.resolve();
      return new Promise<Response>((_resolve, reject) => {
        transferSignal!.addEventListener('abort', () => reject(new DOMException('Synthetic navigation', 'AbortError')), { once: true });
      });
    }
  });
  renderApp('/workspace', { signedInAs: ['clinician'], fetchImpl });
  await attach();
  await send();
  await reached.promise;
  const saved = sessionStorage.getItem(RECOVERY_KEY);
  await newChat();
  expect(transferSignal?.aborted).toBe(true);
  expect(sessionStorage.getItem(RECOVERY_KEY)).toBe(saved);
  expect(await screen.findByRole('link', { name: 'Resume or cancel upload' })).toBeVisible();
  expect(fetchImpl.mock.calls.some(([url]) => String(url).endsWith('/cancel'))).toBe(false);
  expect(screen.queryByText('Upload cancelled.')).not.toBeInTheDocument();
});

it('patient navigation keeps the owning conversation and its upload alive', async () => {
  const reached = deferred<void>();
  const release = deferred<Response>();
  let transferSignal: AbortSignal | null | undefined;
  let uploaded = false;
  const fetchImpl = api(async (path, init) => {
    if (path.endsWith('/bytes')) {
      transferSignal = init?.signal;
      reached.resolve();
      return release.promise;
    }
    if (path === `/api/v1/reports/${OLD_ID}`) return response(report(OLD_ID, 'earlier-synthetic.json', uploaded));
  });
  const { router } = renderApp('/workspace', { signedInAs: ['clinician'], fetchImpl });
  await attach();
  await send();
  await reached.promise;
  await act(async () => {
    await router.navigate('/patients/new');
  });
  await screen.findByRole('heading', { name: 'New patient' });
  expect(transferSignal?.aborted).toBe(false);
  await act(async () => {
    uploaded = true;
    release.resolve(response(attempt('committed')));
  });
  await waitFor(() => expect(stored()).toBeNull());
  await userEvent.click(screen.getByRole('link', { name: 'Back to chat' }));
  expect(await within(screen.getByRole('region', { name: 'Conversation' })).findByText('Received')).toBeVisible();
  expect(fetchImpl.mock.calls.filter(([, init]) => init?.method === 'PUT')).toHaveLength(1);
  expect(fetchImpl.mock.calls.some(([url]) => String(url).endsWith('/cancel'))).toBe(false);
});
