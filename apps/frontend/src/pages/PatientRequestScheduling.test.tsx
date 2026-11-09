import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Role } from '@telesphoros/shared-types';
import { expect, it, vi } from 'vitest';
import { fakeClient, RECOVERY_SCOPE, renderApp } from '@/test/authTestUtils';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const date = '2026-11-01T12:00:00.000Z';
const patient = (id: string) => ({ id, label: id === A ? 'SYN-FIRST' : 'SYN-SECOND', createdAt: date, updatedAt: date, mergedInto: null });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const page = (data: unknown[]) => ({ data, meta: { page: 1, pageSize: 20, total: data.length, totalPages: data.length ? 1 : 0 } });
const demographics = (id: string) => ({
  patientId: id,
  current: true,
  version: 1,
  createdAt: date,
  createdBy: 'synthetic',
  givenName: id === A ? 'First-Synthetic' : 'Second-Synthetic',
  familyName: 'Fixture',
  dateOfBirth: '1980-01-01',
  ageYears: 46,
  birthYear: 1980,
  sex: 'female',
  ethnicity: ['white'],
  versions: [],
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
// Real routing, auth and data readers; only HTTP responses are held to make request ordering and races deterministic.
function api(intercept: (path: string, init?: RequestInit) => Promise<Response | undefined> = async () => undefined, roles: Role[] = ['clinician']) {
  return vi.fn<typeof fetch>(async (input, init) => {
    const path = new URL(String(input)).pathname;
    const handled = await intercept(path, init);
    if (handled) return handled;
    if (path === '/api/v1/me') return json({ roles });
    if (path === '/api/v1/me/recovery-scope') return json({ recoveryScope: RECOVERY_SCOPE });
    if (path === '/api/v1/patients') return json(page([patient(A)]));
    if (path.endsWith('/demographics')) return json(demographics(path.includes(B) ? B : A));
    if (path.endsWith('/medications')) return json({ items: [] });
    if (path === `/api/v1/patients/${A}` || path === `/api/v1/patients/${B}`) return json(patient(path.endsWith(B) ? B : A));
    if (path === '/api/v1/reports' || path === '/api/v1/evaluations') return json(page([]));
    if (path.endsWith('/followups')) return json({ items: [] });
    throw new Error(`Unexpected synthetic request: ${path}`);
  });
}
const requested = (fetchImpl: ReturnType<typeof api>, suffix: string) => fetchImpl.mock.calls.filter(([input]) => new URL(String(input)).pathname === `/api/v1/patients${suffix}`);
const navigate = async (router: ReturnType<typeof renderApp>['router'], path: string) => {
  await act(async () => {
    await router.navigate(path);
  });
};

it('starts identity, demographics and medications before any of those replies settle', async () => {
  const reply = deferred<Response>();
  const fetchImpl = api(async (path) => (path.startsWith(`/api/v1/patients/${A}`) ? reply.promise : undefined));
  renderApp(`/patients/${A}`, { signedInAs: ['clinician'], fetchImpl });
  await waitFor(() => expect(requested(fetchImpl, `/${A}/demographics`)).toHaveLength(1));
  expect(requested(fetchImpl, `/${A}`)).toHaveLength(1);
  await waitFor(() => expect(requested(fetchImpl, `/${A}/medications`)).toHaveLength(1), { timeout: 1000 });
});

it('shows medications after identity arrives while demographics is still loading', async () => {
  const reply = deferred<Response>();
  const fetchImpl = api(async (path) => (path.endsWith('/demographics') ? reply.promise : undefined));
  renderApp(`/patients/${A}`, { signedInAs: ['clinician'], fetchImpl });
  await waitFor(() => expect(requested(fetchImpl, `/${A}/demographics`)).toHaveLength(1));
  expect(await screen.findByText('No medications recorded yet.', {}, { timeout: 1000 })).toBeVisible();
  expect(screen.getByText('Loading demographics…')).toBeInTheDocument();
  await act(async () => {
    reply.resolve(json(demographics(A)));
  });
  expect(await screen.findByText('First-Synthetic')).toBeVisible();
});

it('retries a demographics refusal independently without hiding medications or rereading identity', async () => {
  let refused = true;
  const fetchImpl = api(async (path) => (path.endsWith('/demographics') && refused ? json({}, 403) : undefined));
  renderApp(`/patients/${A}`, { signedInAs: ['clinician'], fetchImpl });
  expect(await screen.findByText('Your role cannot read demographics.')).toBeVisible();
  expect(await screen.findByText('No medications recorded yet.', {}, { timeout: 1000 })).toBeVisible();
  refused = false;
  await userEvent.click(screen.getByRole('button', { name: 'Retry demographics' }));
  expect(await screen.findByText('First-Synthetic')).toBeVisible();
  expect(requested(fetchImpl, `/${A}`)).toHaveLength(1);
  expect(requested(fetchImpl, `/${A}/medications`)).toHaveLength(1);
});

it('keeps demographics available when medications fails, then retries just medications', async () => {
  let refused = true;
  const fetchImpl = api(async (path) => (path.endsWith('/medications') && refused ? json({}, 503) : undefined));
  renderApp(`/patients/${A}`, { signedInAs: ['clinician'], fetchImpl });
  expect(await screen.findByText('First-Synthetic')).toBeVisible();
  await screen.findByText('Medications could not be loaded.');
  refused = false;
  await userEvent.click(screen.getByRole('button', { name: 'Reload medications' }));
  expect(await screen.findByText('No medications recorded yet.')).toBeVisible();
  expect(requested(fetchImpl, `/${A}`)).toHaveLength(1);
  expect(requested(fetchImpl, `/${A}/demographics`)).toHaveLength(1);
});

it.each([403, 404])('withholds patient sections when the identity request returns %s', async (status) => {
  const identity = deferred<Response>();
  const fetchImpl = api(async (path) => (path === `/api/v1/patients/${A}` ? identity.promise : undefined));
  renderApp(`/patients/${A}`, { signedInAs: ['clinician'], fetchImpl });
  await waitFor(() => expect(requested(fetchImpl, `/${A}/demographics`)).toHaveLength(1));
  expect(screen.queryByRole('region', { name: 'Demographics' })).toBeNull();
  expect(screen.queryByRole('region', { name: 'Medications' })).toBeNull();
  await act(async () => {
    identity.resolve(json({}, status));
  });
  expect(await screen.findByText(status === 403 ? 'Your role cannot see this patient.' : 'This patient is not available.')).toBeVisible();
  expect(screen.queryByText('First-Synthetic')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Add medication' })).toBeNull();
});

it('clears a failed identity and its patient data when navigating to another patient', async () => {
  const fetchImpl = api(async (path) => (path === `/api/v1/patients/${A}` ? json({}, 404) : undefined));
  const { router } = renderApp(`/patients/${A}`, { signedInAs: ['clinician'], fetchImpl });
  await screen.findByText('This patient is not available.');
  await navigate(router, `/patients/${B}`);
  expect(await screen.findByRole('heading', { name: 'SYN-SECOND' }, { timeout: 1000 })).toBeVisible();
  expect(await screen.findByText('Second-Synthetic')).toBeVisible();
  expect(screen.queryByText('First-Synthetic')).toBeNull();
});

it.each(['response', 'body'] as const)('ignores a late demographics %s after patient navigation', async (phase) => {
  const reached = deferred<void>();
  const release = deferred<void>();
  let signal: AbortSignal | null | undefined;
  const fetchImpl = api(async (path, init) => {
    if (path !== `/api/v1/patients/${A}/demographics`) return;
    signal = init?.signal;
    const reply = json(demographics(A));
    if (phase === 'body')
      reply.json = async () => {
        reached.resolve();
        await release.promise;
        return demographics(A);
      };
    else {
      reached.resolve();
      await release.promise;
    }
    return reply;
  });
  const { router } = renderApp(`/patients/${A}`, { signedInAs: ['clinician'], fetchImpl });
  await reached.promise;
  await navigate(router, `/patients/${B}`);
  expect(signal?.aborted).toBe(true);
  expect(await screen.findByText('Second-Synthetic')).toBeVisible();
  await act(async () => {
    release.resolve();
  });
  expect(screen.queryByText('First-Synthetic')).toBeNull();
  expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('SYN-SECOND');
});

it('does not issue patient reads for an administrator without a clinical read role', async () => {
  const fetchImpl = api(undefined, ['admin']);
  renderApp(`/patients/${A}`, { signedInAs: ['admin'], fetchImpl });
  await screen.findByRole('heading', { name: 'You do not have access to this page' });
  expect(fetchImpl.mock.calls.some(([input]) => String(input).includes('/api/v1/patients'))).toBe(false);
});

it.each(['identity', 'demographics'] as const)('refuses a %s response naming another patient', async (resource) => {
  const fetchImpl = api(async (path) => {
    if (resource === 'identity' && path === `/api/v1/patients/${A}`) return json(patient(B));
    if (resource === 'demographics' && path === `/api/v1/patients/${A}/demographics`) return json(demographics(B));
  });
  renderApp(`/patients/${A}`, { signedInAs: ['clinician'], fetchImpl });
  const message = resource === 'identity' ? 'The patient could not be loaded. Please retry.' : 'The demographics could not be loaded. Please retry.';
  await waitFor(() => expect(requested(fetchImpl, resource === 'identity' ? `/${A}` : `/${A}/demographics`)).toHaveLength(1));
  await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(message), { timeout: 1000 });
  expect(screen.queryByText('SYN-SECOND')).toBeNull();
  expect(screen.queryByText('Second-Synthetic')).toBeNull();
});

it('discards a late demographics body after a concurrent medication 401 ends the session', async () => {
  const reached = deferred<void>();
  const release = deferred<void>();
  const medication = deferred<Response>();
  let signal: AbortSignal | null | undefined;
  const fetchImpl = api(async (path, init) => {
    if (path.endsWith('/medications')) return medication.promise;
    if (!path.endsWith('/demographics')) return;
    signal = init?.signal;
    const response = json(demographics(A));
    response.json = async () => {
      reached.resolve();
      await release.promise;
      return demographics(A);
    };
    return response;
  });
  const client = fakeClient({ returnTo: `/patients/${A}` });
  renderApp(`/patients/${A}`, { signedInAs: ['clinician'], fetchImpl, client });
  await reached.promise;
  await act(async () => {
    medication.resolve(json({}, 401));
  });
  await waitFor(() => expect(client.signIn).toHaveBeenCalled());
  await waitFor(() => expect(signal?.aborted).toBe(true));
  await act(async () => {
    release.resolve();
  });
  expect(screen.queryByText('First-Synthetic')).toBeNull();
  expect(screen.queryByRole('region', { name: 'Medications' })).toBeNull();
});

it('defers the attachment roster on a patient page and loads it on first attachment', async () => {
  const fetchImpl = api();
  const { router } = renderApp(`/patients/${A}`, { signedInAs: ['clinician'], fetchImpl });
  await screen.findByText('First-Synthetic');
  expect(requested(fetchImpl, '')).toHaveLength(0);
  await navigate(router, '/workspace');
  await screen.findByRole('button', { name: 'Attach a report' });
  expect(requested(fetchImpl, '')).toHaveLength(0);
  await userEvent.upload(document.querySelector<HTMLInputElement>('input[type=file]')!, new File(['{}'], 'synthetic.json', { type: 'application/json' }));
  await waitFor(() => expect(screen.getByRole('combobox', { name: 'Patient' })).toHaveValue(A));
  expect(requested(fetchImpl, '')).toHaveLength(1);
});

it('keeps a pending roster and attachment alive across patient navigation', async () => {
  const roster = deferred<Response>();
  let signal: AbortSignal | null | undefined;
  const fetchImpl = api(async (path, init) => {
    if (path === '/api/v1/patients') {
      signal = init?.signal;
      return roster.promise;
    }
  });
  const { router } = renderApp('/workspace', { signedInAs: ['clinician'], fetchImpl });
  await screen.findByRole('button', { name: 'Attach a report' });
  await userEvent.upload(document.querySelector<HTMLInputElement>('input[type=file]')!, new File(['{}'], 'synthetic.json', { type: 'application/json' }));
  await waitFor(() => expect(requested(fetchImpl, '')).toHaveLength(1));
  await navigate(router, `/patients/${A}`);
  await screen.findByText('First-Synthetic');
  expect(signal?.aborted).toBe(false);
  await act(async () => {
    roster.resolve(json(page([patient(A)])));
  });
  await navigate(router, '/workspace');
  await userEvent.click(await screen.findByRole('button', { name: 'Report details' }));
  expect(await screen.findByRole('dialog', { name: 'Report details' })).toBeVisible();
  expect(screen.getByRole('combobox', { name: 'Patient' })).toHaveValue(A);
  expect(requested(fetchImpl, '')).toHaveLength(1);
  const ownedSignal = signal;
  await userEvent.click(within(screen.getByRole('navigation', { name: 'Primary' })).getByRole('link', { name: 'New chat' }));
  expect(ownedSignal?.aborted).toBe(true);
});
