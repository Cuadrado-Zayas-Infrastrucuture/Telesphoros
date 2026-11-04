import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { evaluationSummaryDtoSchema } from '@telesphoros/shared-types';
import { ResultsList } from './ResultsList';

const auth = vi.hoisted(() => ({ apiFetch: vi.fn(), roles: ['clinician'] as string[] }));
vi.mock('@/auth/AuthProvider', () => ({ useAuth: () => auth }));
vi.mock('./DecisionPanel', () => ({ DecisionPanel: () => <p>decision panel</p> }));

const patientId = '22222222-2222-4222-8222-222222222222';
const evaluation = {
  id: '66666666-6666-4666-8666-666666666666',
  reportId: '11111111-1111-4111-8111-111111111111',
  patientId,
  captureId: null,
  acceptance: null,
  disposition: 'evaluated',
  holdCode: null,
  hold: null,
  knowledgeSetId: 'a'.repeat(64),
  engineVersion: 'sha256-abcdef012345',
  scope: 'synthetic-structured-assessment',
  clinicalUse: 'not-approved',
  state: 'active',
  supersededBy: null,
  results: [
    {
      id: '55555555-5555-4555-8555-555555555555',
      ordinal: 0,
      drug: 'drugz',
      genes: ['GENEA', 'GENEB'],
      outcome: 'shown',
      reasonCode: null,
      strength: 'Strong',
      citation: { guidelineId: 'drugz-genea-geneb' },
      recommendationText: 'Z normal-low.',
      implication: null,
      geneEvidence: null,
    },
  ],
  geneStates: [],
  corrections: [],
  current: true,
  advisory: { activeDisputes: 0, patientLink: 'verified' },
  actionable: false,
  createdAt: '2026-11-04T00:00:00Z',
};
const list = () => new Response(JSON.stringify({ data: [evaluation], meta: { page: 1, pageSize: 10, total: 1, totalPages: 1 } }), { status: 200 });
const show = () => render(<ResultsList patientId={patientId} followupBusy={false} onFollowup={() => undefined} />);

beforeEach(() => {
  auth.apiFetch.mockReset();
  auth.apiFetch.mockImplementation(async () => list());
});
afterEach(() => vi.unstubAllEnvs());

it('the fixture is a valid evaluation summary, so the cases below test the list and not the fixture', () => {
  expect(() => evaluationSummaryDtoSchema.parse(evaluation)).not.toThrow();
});

it('offers decisions on a stored result in an ordinary build (control for the staging case below)', async () => {
  show();
  expect(await screen.findByText('Z normal-low.')).toBeVisible();
  expect(screen.getByRole('button', { name: 'Decision and history' })).toBeVisible();
  expect(screen.getByText(/Decisions below document intent only/)).toBeVisible();
});

it('shows the result and its source but offers no decisions in the synthetic staging, where they are not switched on', async () => {
  vi.stubEnv('VITE_SYNTHETIC_ASSESSMENT', 'true');
  show();
  expect(await screen.findByText('Z normal-low.')).toBeVisible();
  expect(screen.getByText(/Source and provenance/)).toBeVisible();
  expect(screen.queryByRole('button', { name: 'Decision and history' })).not.toBeInTheDocument();
  expect(screen.queryByText(/Decisions below document intent only/)).not.toBeInTheDocument();
  expect(screen.getByText(/Clinical use is not approved/)).toBeVisible();
});
