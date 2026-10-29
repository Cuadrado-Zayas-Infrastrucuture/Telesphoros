import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UploadProgress } from '@/lib/api';
import { DEMO_SOURCE } from '@/lib/interpretationDemo';
import LocalWorkspacePage from './LocalWorkspacePage';

const PATIENT = { id: '0f8fad5b-d9cb-469f-a165-70867728950e', label: 'SYN-004', createdAt: '2026-10-28T12:00:00.000Z', updatedAt: '2026-10-28T12:00:00.000Z', mergedInto: null };
let release: () => void = () => undefined;

vi.mock('@/auth/AuthProvider', async (actual) => ({
  ...(await actual<typeof import('@/auth/AuthProvider')>()),
  useAuth: () => ({ roles: ['clinician'], apiFetch: vi.fn(), recoverySession: null, signOut: vi.fn() }),
}));
vi.mock('@/lib/api', async (actual) => ({
  ...(await actual<typeof import('@/lib/api')>()),
  listPatients: vi.fn(async () => ({ data: [PATIENT], meta: { page: 1, pageSize: 20, total: 1, totalPages: 1 } })),
  // A stand-in for the validated intake: the server reports "stored", then the upload is confirmed when the test releases it.
  submitReport: vi.fn(async (_values: unknown, _api: unknown, progress: UploadProgress) => {
    progress.attempt = {
      attemptId: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
      revision: '7c9e6679-7425-40de-944b-e07fc1f90ae8',
      expiresAt: '2026-10-29T12:00:00.000Z',
      state: 'stored',
    };
    await new Promise<void>((resolve) => (release = resolve));
    return { reference: 'ref' };
  }),
}));

// Real timers: under fake timers the page's first render never settled. Each state is awaited instead.
beforeEach(() => vi.stubGlobal('location', { hostname: '127.0.0.1' }));
afterEach(() => vi.unstubAllGlobals());
const slow = { timeout: 5000 };

const open = () =>
  render(
    <MemoryRouter>
      <LocalWorkspacePage />
    </MemoryRouter>,
  );

describe('one-screen workspace on Prompt Kit (specs/021)', () => {
  it('shows the thinking bar while answering, then a message with the demo source, feedback and the synthetic notice', async () => {
    open();
    expect(await screen.findByRole('form', { name: 'Report and question' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Explain this example' }));
    expect(await screen.findByRole('group', { name: 'Sample response preparation' })).toBeInTheDocument();
    expect(await screen.findByText(/No genotype, phenotype/, {}, slow)).toBeInTheDocument();
    expect(screen.getByText(DEMO_SOURCE)).toBeInTheDocument();
    const helpful = screen.getByRole('button', { name: 'Helpful' });
    fireEvent.click(helpful);
    expect(helpful).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getAllByText('Synthetic data only. Not for clinical use.').length).toBeGreaterThan(0);
  });

  it('lights the upload steps from the server’s state, and the source then says the engine did not read the report', async () => {
    open();
    await screen.findByRole('form', { name: 'Report and question' });
    const input = document.querySelector<HTMLInputElement>('input[type=file]')!;
    fireEvent.change(input, { target: { files: [new File(['{"synthetic":true}'], 'SYN-004.json')] } });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Synthetic' }));
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    const steps = await screen.findByRole('list', { name: 'Upload of SYN-004.json' });
    await waitFor(() => expect(within(steps).getAllByText('Done')).toHaveLength(2), slow);
    expect(within(steps).getByText('In progress')).toBeInTheDocument();
    // Not wrapped in act(): act waits for all work to settle, and the page's 150 ms progress poll keeps scheduling more. waitFor handles the update.
    release();
    await waitFor(() => expect(within(steps).getAllByText('Done')).toHaveLength(3), slow);
    fireEvent.click(screen.getByRole('button', { name: 'Explain this example' }));
    expect(await screen.findByText('Attached: SYN-004.json · not read by the sample engine', {}, slow)).toBeInTheDocument();
    expect(screen.queryByText(DEMO_SOURCE)).not.toBeInTheDocument();
  });
});
