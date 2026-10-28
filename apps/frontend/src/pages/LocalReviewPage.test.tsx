/** @vitest-environment-options {"url":"http://127.0.0.1:4173"} */
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react';
import { vi, it, expect, beforeEach, afterEach, describe } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import LocalReviewPage from './LocalReviewPage';
const mocks = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  roles: ['reviewer'],
  pdfHash: 'a'.repeat(64),
}));
vi.mock('@/auth/AuthProvider', () => ({ useAuth: () => mocks }));
const id = '11111111-1111-4111-8111-111111111111';
beforeEach(() => {
  mocks.roles = ['reviewer'];
  mocks.pdfHash = 'a'.repeat(64);
  mocks.apiFetch.mockReset();
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('SYNTHETIC TEXT')));
});
function setup(decision: 'accepted' | 'rejected' | null = null, url = 'http://127.0.0.1:5555/file') {
  mocks.apiFetch.mockImplementation(
    async (path: string) =>
      new Response(
        JSON.stringify(
          path.endsWith('-url')
            ? { url, expiresAt: '2026-10-09T00:00:00Z' }
            : {
                id,
                reportId: id,
                pdfSha256: mocks.pdfHash,
                textSha256: 'b'.repeat(64),
                textScalars: 14,
                popplerVersion: '26.03.0',
                runner: 'fake',
                createdAt: 'now',
                latestDecision: decision
                  ? {
                      id,
                      captureId: id,
                      decision,
                      textSha256: 'b'.repeat(64),
                      popplerVersion: '26.03.0',
                      note: null,
                      createdAt: 'now',
                    }
                  : null,
              },
        ),
      ),
  );
  render(
    <MemoryRouter>
      <LocalReviewPage />
    </MemoryRouter>,
  );
  fireEvent.change(screen.getByLabelText('Capture ID'), {
    target: { value: id },
  });
  fireEvent.click(screen.getByText('Open capture'));
}
it('requires explicit comparison before reviewer decision and blocks pending evaluation', async () => {
  setup();
  await screen.findByText('SYNTHETIC TEXT');
  expect(screen.getByText('Accept capture')).toBeDisabled();
  expect(screen.getByText('Run synthetic evaluation')).toBeDisabled();
  fireEvent.click(screen.getByLabelText('I compared the PDF and stored text, including field associations'));
  expect(screen.getByText('Accept capture')).toBeEnabled();
});
it('clinician cannot decide even after comparison', async () => {
  mocks.roles = ['clinician'];
  setup();
  await screen.findByText('SYNTHETIC TEXT');
  fireEvent.click(screen.getByLabelText('I compared the PDF and stored text, including field associations'));
  expect(screen.getByText('Accept capture')).toBeDisabled();
});
it('rejected capture cannot evaluate', async () => {
  setup('rejected');
  await screen.findByText('SYNTHETIC TEXT');
  expect(screen.getByText('Run synthetic evaluation')).toBeDisabled();
});
it('refuses an external file link before fetching text', async () => {
  setup(null, 'https://example.test/file');
  await screen.findByText('File destination is not the local emulator.');
  expect(fetch).not.toHaveBeenCalled();
});

it('does not show a registered PDF preview for another hash', async () => {
  setup();
  await screen.findByText('SYNTHETIC TEXT');
  expect(screen.queryByAltText('Rendered source PDF, D01 synthetic fixture')).not.toBeInTheDocument();
});
it('shows the registered D01 preview for its exact PDF hash', async () => {
  mocks.pdfHash = '6b6d2a4578ac5ca2ac49db080d440320f3341b81ea0b81a7e29113a166c893f0';
  setup();
  await screen.findByText('SYNTHETIC TEXT');
  expect(screen.getByAltText('Rendered source PDF, D01 synthetic fixture')).toBeInTheDocument();
});

it('shows a capture field error, focuses it and does not request an invalid ID', async () => {
  render(
    <MemoryRouter>
      <LocalReviewPage />
    </MemoryRouter>,
  );
  fireEvent.click(screen.getByText('Open capture'));
  const field = screen.getByLabelText('Capture ID');
  await screen.findByText('Enter a valid capture ID.');
  expect(field).toHaveAttribute('aria-invalid', 'true');
  expect(field).toHaveAccessibleDescription('Enter a valid capture ID.');
  expect(field).toHaveFocus();
  expect(mocks.apiFetch).not.toHaveBeenCalled();
});
it('shows each missing upload field without starting a request', async () => {
  render(
    <MemoryRouter>
      <LocalReviewPage />
    </MemoryRouter>,
  );
  fireEvent.click(screen.getByText('Upload and capture'));
  expect(await screen.findByText('Enter a SYN- label.')).toBeVisible();
  expect(screen.getByLabelText('Synthetic label')).toHaveFocus();
  expect(screen.getByLabelText('PDF fixture')).toHaveAttribute('aria-invalid', 'true');
  expect(mocks.apiFetch).not.toHaveBeenCalled();
});

it('allows only one capture request from two same-turn clicks', () => {
  mocks.apiFetch.mockReturnValue(new Promise(() => {}));
  render(
    <MemoryRouter>
      <LocalReviewPage />
    </MemoryRouter>,
  );
  fireEvent.change(screen.getByLabelText('Capture ID'), { target: { value: id } });
  const button = screen.getByText('Open capture');
  act(() => {
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  expect(mocks.apiFetch).toHaveBeenCalledTimes(1);
});

it('records the patient link only after comparison, only for a reviewer, with a coded reason and no identifier', async () => {
  setup('accepted');
  await screen.findByText('SYNTHETIC TEXT');
  const confirm = screen.getByText('Confirm this report belongs to its patient');
  expect(confirm).toBeDisabled();
  fireEvent.click(screen.getByLabelText('I compared the PDF and stored text, including field associations'));
  expect(confirm).toBeEnabled();
  mocks.apiFetch.mockClear();
  fireEvent.click(confirm);
  await screen.findByText('Patient link recorded as verified.');
  expect(mocks.apiFetch).toHaveBeenCalledTimes(1);
  const [path, init] = mocks.apiFetch.mock.calls[0]!;
  expect(path).toBe('/api/v1/reports/' + id + '/patient-link/decisions');
  expect(JSON.parse((init as { body: string }).body)).toEqual({
    decision: 'verified',
    method: 'person-confirmed',
    basisCode: 'documented-clinic-procedure',
  });
});
it('does not let a clinician record the patient link from this page', async () => {
  mocks.roles = ['clinician'];
  setup('accepted');
  await screen.findByText('SYNTHETIC TEXT');
  fireEvent.click(screen.getByLabelText('I compared the PDF and stored text, including field associations'));
  expect(screen.getByText('Confirm this report belongs to its patient')).toBeDisabled();
});

// H4 slice 3 (spec 007, T030 to T032): the queued path. The API is scripted by route; polling runs on fake timers.
describe('queued synthetic evaluation', () => {
  const requestId = '22222222-2222-4222-8222-222222222222';
  const evaluationId = '33333333-3333-4333-8333-333333333333';
  const evaluation = {
    id: evaluationId,
    reportId: id,
    patientId: id,
    captureId: id,
    acceptance: null,
    disposition: 'held',
    holdCode: 'unsupported-layout',
    hold: { message: 'Synthetic hold', reviewerAction: 'Review' },
    knowledgeSetId: 'syn',
    engineVersion: 'test',
    scope: null,
    clinicalUse: 'not-approved',
    state: 'active',
    supersededBy: null,
    results: [],
    geneStates: [],
    geneInputs: [],
    corrections: [],
    current: true,
    advisory: { activeDisputes: 0, patientLink: 'verified' },
    actionable: false,
    createdAt: 'now',
  };
  const request = (state: string) => ({
    id: requestId,
    reportId: id,
    captureId: id,
    acceptanceId: id,
    jobId: id,
    requestedBy: 'alice',
    createdAt: '2026-10-28T00:00:00.000Z',
    state,
    evaluationId: state === 'completed' ? evaluationId : null,
  });
  const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
  const calls = (match: (path: string, method: string) => boolean) =>
    mocks.apiFetch.mock.calls.filter(([path, init]) => match(path as string, (init as { method?: string } | undefined)?.method ?? 'GET'));
  const polls = () => calls((path, method) => method === 'GET' && path === `/api/v1/evaluation-requests/${requestId}`).length;
  const posts = () => calls((path, method) => method === 'POST' && path === `/api/v1/reports/${id}/evaluation-requests`);

  /** An accepted capture on screen, then the queued routes scripted: `states` is what each status read returns, the last one repeating. */
  async function ready(states: string[], admission: () => Response = () => json(request('queued'), 202)) {
    const queue = [...states];
    setup('accepted');
    await screen.findByText('SYNTHETIC TEXT');
    const base = mocks.apiFetch.getMockImplementation()!;
    mocks.apiFetch.mockImplementation(async (path: string, init?: { method?: string }) => {
      const method = init?.method ?? 'GET';
      if (method === 'POST' && path === `/api/v1/reports/${id}/evaluation-requests`) return admission();
      if (method === 'POST' && path === `/api/v1/evaluation-requests/${requestId}/cancel`) return json(request('cancelled'));
      if (method === 'GET' && path === `/api/v1/evaluation-requests/${requestId}`) return json(request(queue.length > 1 ? queue.shift()! : queue[0]!));
      if (method === 'GET' && path === `/api/v1/evaluations/${evaluationId}`) return json(evaluation);
      return base(path, init);
    });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  }
  const flush = () => act(async () => void (await vi.advanceTimersByTimeAsync(0)));
  const wait = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));
  const queueIt = async () => {
    fireEvent.click(screen.getByText('Queue synthetic evaluation'));
    await flush();
  };

  afterEach(() => {
    vi.useRealTimers();
  });

  it('queues, follows the state, and shows the stored evaluation once completed, then stops asking', async () => {
    await ready(['running', 'completed']);
    await queueIt();
    expect(screen.getByText('Queued evaluation: queued.')).toBeInTheDocument();

    await wait(1000);
    expect(screen.getByText('Queued evaluation: running.')).toBeInTheDocument();
    await wait(2000);
    expect(screen.getByText('Queued evaluation: completed.')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Evaluation result' })).toHaveTextContent(evaluationId);

    const asked = polls();
    await wait(60_000);
    expect(polls()).toBe(asked);
  });

  it('asks again after 1, 2 and 4 seconds, then every 10 seconds', async () => {
    await ready(['queued']);
    await queueIt();
    const seen: number[] = [];
    for (const step of [1000, 2000, 4000, 10_000, 10_000]) {
      await wait(step - 1);
      seen.push(polls());
      await wait(1);
      seen.push(polls());
    }
    expect(seen).toEqual([0, 1, 1, 2, 2, 3, 3, 4, 4, 5]);
  });

  it('stops after five minutes without a result, says so, and infers nothing', async () => {
    await ready(['queued']);
    await queueIt();
    await wait(5 * 60_000 + 10_000);
    expect(screen.getByText('No result yet; a worker may not be running. Nothing is inferred.')).toBeInTheDocument();
    const asked = polls();
    await wait(60_000);
    expect(polls()).toBe(asked);
    expect(screen.queryByRole('region', { name: 'Evaluation result' })).not.toBeInTheDocument();
  });

  it('stops asking when the page goes away', async () => {
    await ready(['queued']);
    await queueIt();
    const asked = polls();
    cleanup();
    await wait(60_000);
    expect(polls()).toBe(asked);
  });

  it('sends the same request id when asked twice for the same capture, so the API replays instead of queueing again', async () => {
    await ready(['queued']);
    await queueIt();
    await queueIt();
    expect(posts()).toHaveLength(2);
    const ids = posts().map(([, init]) => JSON.parse((init as { body: string }).body));
    expect(ids[0]).toEqual({ captureId: id, acceptanceId: id, requestId: expect.stringMatching(/^[0-9a-f-]{36}$/) });
    expect(ids[1]!.requestId).toBe(ids[0]!.requestId);
  });

  it('lets the requester cancel while it waits, then shows it cancelled and stops asking', async () => {
    await ready(['queued']);
    await queueIt();
    fireEvent.click(screen.getByText('Cancel queued evaluation'));
    await flush();
    expect(calls((path, method) => method === 'POST' && path === `/api/v1/evaluation-requests/${requestId}/cancel`)).toHaveLength(1);
    expect(screen.getByText('Queued evaluation: cancelled.')).toBeInTheDocument();
    expect(screen.queryByText('Cancel queued evaluation')).not.toBeInTheDocument();
    const asked = polls();
    await wait(60_000);
    expect(polls()).toBe(asked);
  });

  it.each([
    ['dead', 'Queued evaluation: stopped. The worker gave up; there is no result.'],
    ['completion-missing', 'Queued evaluation: finished without a stored result. Nothing is inferred.'],
  ])('shows %s as an operational state, never as a result', async (state, words) => {
    await ready([state]);
    await queueIt();
    await wait(1000);
    expect(screen.getByText(words)).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Evaluation result' })).not.toBeInTheDocument();
    expect(screen.queryByText('Cancel queued evaluation')).not.toBeInTheDocument();
  });

  it('says plainly when queued evaluation is switched off, and does not poll', async () => {
    await ready(['queued'], () => json({ error: { code: 'EVALUATION_REQUESTS_DISABLED', message: 'Queued evaluation requests are switched off.' } }, 503));
    await queueIt();
    expect(screen.getByText('Queued evaluation is turned off here.')).toBeInTheDocument();
    await wait(60_000);
    expect(polls()).toBe(0);
  });
});
