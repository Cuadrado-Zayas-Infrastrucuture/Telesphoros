import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ResultAcknowledgementDto, ResultAcknowledgementsDto } from '@telesphoros/shared-types';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import ResultAcknowledgementsTestPage from '@/pages/ResultAcknowledgementsTestPage';
import { ReviewedControl } from './ReviewedControl';

// Spec 019 D02a, T007 and the frontend's verification scenario (a patient change invalidates pending actions). The API is a hand-written fake; every
// expected request and screen is written by hand. Synthetic ids only.
const auth = vi.hoisted(() => ({ roles: ['clinician'] as string[], apiFetch: vi.fn<(path: string, init?: RequestInit) => Promise<Response>>() }));
vi.mock('@/auth/AuthProvider', async (original) => ({ ...(await original<object>()), useAuth: () => auth }));

const R1 = '1c1f0b4d-7a72-4e9f-8a2b-2d3e4f5a6b7c';
const R2 = '3e3b2d6f-9c94-4ab1-8c4d-4f5a6b7c8d9e';
const P1 = '2d2a1c5e-8b83-4fa0-9b3c-3e4f5a6b7c8d';
const P2 = '4f4c3e7a-ad05-4bc2-9d5e-5a6b7c8d9e0f';
const E1 = '5a5d4f8b-be16-4cd3-8e6f-6b7c8d9e0f1a';
const CREATED = '2026-10-29T15:04:05.000000Z';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const refusal = (reason: string) => json({ error: { code: 'CONFLICT', message: 'x', details: [{ field: 'request', message: 'x', reason }], requestId: 'r' } }, 409);
const status = (resultId: string, basis: ResultAcknowledgementsDto['basis'], acknowledgements: ResultAcknowledgementsDto['acknowledgements'] = [], patientId = P1) => ({
  resultId,
  evaluationId: E1,
  patientId,
  basis,
  acknowledgements,
  clinicalUse: 'not-approved' as const,
  actionable: false as const,
});
const stored = (resultId: string, kind: ResultAcknowledgementDto['kind'], basis: ResultAcknowledgementDto['basis'], patientId = P1): ResultAcknowledgementDto => ({
  id: '6b6e5a9c-cf27-4de4-9f7a-7c8d9e0f1a2b',
  resultId,
  evaluationId: E1,
  patientId,
  kind,
  reviewTask: 'result-review',
  basis,
  basisRule: 'cdr-basis-v1',
  createdAt: CREATED,
  createdBy: 'syn-clinician',
  authorRoles: ['clinician'],
});

interface Deferred {
  resolve: (r: Response) => void;
  reject: (e: unknown) => void;
}
/** The fake API: GETs answer from `gets` in turn (the last repeats); POSTs answer from `posts` in turn, each a Response, an error, or 'pending'. */
function api(gets: Record<string, Array<() => Response>>, posts: Array<(() => Response) | 'network' | 'pending'> = []) {
  const pending: Deferred[] = [];
  const getCalls: Record<string, number> = {};
  let postCall = 0;
  auth.apiFetch.mockImplementation(async (path, init) => {
    const id = /evaluation-results\/([^/]+)\/acknowledgements$/.exec(path)?.[1];
    if (!id) return json({}, 404);
    if ((init?.method ?? 'GET') === 'GET') {
      const answers = gets[id] ?? [() => json({}, 404)];
      const n = (getCalls[id] = (getCalls[id] ?? 0) + 1);
      return answers[Math.min(n - 1, answers.length - 1)]!();
    }
    const answer = posts[Math.min(postCall++, posts.length - 1)];
    if (answer === 'network') throw new TypeError('Failed to fetch');
    if (answer === 'pending' || answer === undefined) return new Promise<Response>((resolve, reject) => pending.push({ resolve, reject }));
    return answer();
  });
  return { pending };
}
const postsMade = () => auth.apiFetch.mock.calls.filter(([, init]) => init?.method === 'POST');
const bodyOf = (n: number) => JSON.parse(String(postsMade()[n]![1]!.body));

beforeEach(() => {
  auth.roles = ['clinician'];
  auth.apiFetch.mockReset();
});

describe('ReviewedControl', () => {
  it('offers Review on an active result, shows sending, and says Reviewed only after the server stores it (201); axe clean in each state', async () => {
    const { pending } = api({ [R1]: [() => json(status(R1, ['active']))] }, ['pending']);
    const { container } = render(<ReviewedControl resultId={R1} />);
    expect(screen.getByRole('status')).toHaveTextContent('Loading review status');
    const button = await screen.findByRole('button', { name: 'Review' });
    expect(await axe(container)).toHaveNoViolations();
    await userEvent.click(button);
    expect(screen.getByRole('button', { name: 'Review' })).toBeDisabled();
    expect(screen.getByRole('status')).toHaveTextContent('Saving review');
    expect(screen.queryByText('Reviewed')).not.toBeInTheDocument(); // P4: nothing says saved before the server does
    expect(await axe(container)).toHaveNoViolations();
    expect(bodyOf(0)).toEqual({
      requestId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      resultId: R1,
      patientId: P1,
      kind: 'review',
      reviewTask: 'result-review',
      displayedBasis: ['active'],
    });
    await act(async () => pending[0]!.resolve(json(stored(R1, 'review', ['active']), 201)));
    const done = await screen.findByRole('status');
    expect(within(done).getByText('Reviewed')).toHaveClass('text-success');
    expect(done.querySelector('time')).toHaveAttribute('dateTime', CREATED);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();
  });

  it('on a retracted result offers only "Retraction reviewed", and sends that kind', async () => {
    api({ [R1]: [() => json(status(R1, ['retracted']))] }, [() => json(stored(R1, 'retraction-reviewed', ['retracted']), 201)]);
    render(<ReviewedControl resultId={R1} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Retraction reviewed' }));
    expect(screen.queryByRole('button', { name: 'Review' })).not.toBeInTheDocument();
    expect(bodyOf(0)).toMatchObject({ kind: 'retraction-reviewed', displayedBasis: ['retracted'] });
    expect(await screen.findByRole('status')).toHaveTextContent('Retraction reviewed by you');
  });

  it('shows the caller’s own current review as Reviewed on load; a review made before the basis changed is history, so Review is offered again', async () => {
    const own = { ...stored(R1, 'review', ['active']), basisIsCurrent: true, byYou: true };
    api({ [R1]: [() => json(status(R1, ['active'], [own]))], [R2]: [() => json(status(R2, ['retracted'], [{ ...own, resultId: R2, basisIsCurrent: false }]))] });
    render(
      <>
        <ReviewedControl resultId={R1} />
        <ReviewedControl resultId={R2} />
      </>,
    );
    expect(await within(screen.getByRole('group', { name: `Review of result ${R1}` })).findByText('Reviewed')).toBeInTheDocument();
    expect(await within(screen.getByRole('group', { name: `Review of result ${R2}` })).findByRole('button', { name: 'Retraction reviewed' })).toBeInTheDocument();
  });

  it('scenario 2: a 409 acknowledgement-basis-changed is refused with a Refresh; after it only "Retraction reviewed" is offered, and nothing said Reviewed', async () => {
    api({ [R1]: [() => json(status(R1, ['active'])), () => json(status(R1, ['retracted']))] }, [() => refusal('acknowledgement-basis-changed')]);
    const { container } = render(<ReviewedControl resultId={R1} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Review' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('This result changed after it was shown');
    expect(screen.queryByText('Reviewed')).not.toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();
    await userEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(await screen.findByRole('button', { name: 'Retraction reviewed' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Review' })).not.toBeInTheDocument();
  });

  it('a 409 already-acknowledged says so, and is not shown as a new review', async () => {
    api({ [R1]: [() => json(status(R1, ['active']))] }, [() => refusal('already-acknowledged')]);
    render(<ReviewedControl resultId={R1} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Review' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('You already recorded this review.');
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeInTheDocument();
  });

  it('scenario 4: a lost answer shows failed, and Retry resends the SAME request (so the server replays it, 200) before saying Reviewed', async () => {
    api({ [R1]: [() => json(status(R1, ['active']))] }, ['network', () => json(stored(R1, 'review', ['active']), 200)]);
    const { container } = render(<ReviewedControl resultId={R1} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Review' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('The review was not confirmed');
    expect(screen.queryByText('Reviewed')).not.toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Reviewed')).toBeInTheDocument();
    expect(postsMade()).toHaveLength(2);
    expect(bodyOf(1)).toEqual(bodyOf(0));
  });

  it('a server error or an answer that breaks the contract is a failure, never a success', async () => {
    api({ [R1]: [() => json(status(R1, ['active']))] }, [() => json({}, 500), () => json({ id: 'not-an-acknowledgement' }, 201)]);
    render(<ReviewedControl resultId={R1} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Review' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('The review was not confirmed');
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('The review was not confirmed');
    expect(screen.queryByText('Reviewed')).not.toBeInTheDocument();
  });

  it('a failed load says so and offers a Retry that works', async () => {
    api({ [R1]: [() => json({}, 500), () => json(status(R1, ['active']))] });
    render(<ReviewedControl resultId={R1} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Review status could not be loaded.');
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('button', { name: 'Review' })).toBeInTheDocument();
  });

  it('offers no Review to a role that cannot record one', async () => {
    auth.roles = ['reader'];
    api({ [R1]: [() => json(status(R1, ['active']))] });
    render(<ReviewedControl resultId={R1} />);
    expect(await screen.findByText('Only a clinician can record a review.')).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('a pending review for one result is abandoned when the result changes: its late 201 is never shown, and nothing is sent for the new one', async () => {
    const { pending } = api({ [R1]: [() => json(status(R1, ['active']))], [R2]: [() => json(status(R2, ['active'], [], P2))] }, ['pending']);
    const { rerender } = render(<ReviewedControl resultId={R1} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Review' }));
    const firstSignal = postsMade()[0]![1]!.signal!;
    rerender(<ReviewedControl resultId={R2} />);
    expect(firstSignal.aborted).toBe(true);
    await act(async () => pending[0]!.resolve(json(stored(R1, 'review', ['active']), 201)));
    expect(await screen.findByRole('button', { name: 'Review' })).toBeEnabled();
    expect(screen.queryByText('Reviewed')).not.toBeInTheDocument();
    expect(postsMade()).toHaveLength(1);
  });
});

describe('the test-only page (scenario 3: the patient context changes)', () => {
  const open = (url: string) => {
    const router = createMemoryRouter([{ path: '/e2e/result-acknowledgements', Component: ResultAcknowledgementsTestPage }], { initialEntries: [url] });
    return { router, ...render(<RouterProvider router={router} />) };
  };

  it('lists the results by id only, each with its control; axe clean', async () => {
    api({ [R1]: [() => json(status(R1, ['active']))], [R2]: [() => json(status(R2, ['retracted']))] });
    const { container } = open(`/e2e/result-acknowledgements?patient=${P1}&result=${R1}&result=${R2}`);
    expect(await screen.findByRole('heading', { level: 1, name: 'Result acknowledgements' })).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Review' })).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Retraction reviewed' })).toBeInTheDocument();
    expect(screen.getByText(R1)).toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();
  });

  it('a patient change while a review is pending abandons it: nothing submits or shows against the previous patient', async () => {
    const { pending } = api({ [R1]: [() => json(status(R1, ['active']))], [R2]: [() => json(status(R2, ['active'], [], P2))] }, ['pending']);
    const { router } = open(`/e2e/result-acknowledgements?patient=${P1}&result=${R1}`);
    await userEvent.click(await screen.findByRole('button', { name: 'Review' }));
    const firstSignal = postsMade()[0]![1]!.signal!;
    await act(async () => router.navigate(`/e2e/result-acknowledgements?patient=${P2}&result=${R1}`)); // the same result id, another patient: still a new mount
    expect(firstSignal.aborted).toBe(true);
    await act(async () => pending[0]!.resolve(json(stored(R1, 'review', ['active']), 201)));
    expect(await screen.findByRole('button', { name: 'Review' })).toBeEnabled();
    expect(screen.queryByText('Reviewed')).not.toBeInTheDocument();
    expect(postsMade()).toHaveLength(1); // the only POST was the abandoned one, made for the previous patient
  });

  it('refuses an address without a valid patient and results', async () => {
    open('/e2e/result-acknowledgements?patient=nope&result=also-nope');
    expect(await screen.findByText('Name a patient and up to 20 results by id in the address.')).toBeInTheDocument();
    expect(auth.apiFetch).not.toHaveBeenCalled();
  });
});
