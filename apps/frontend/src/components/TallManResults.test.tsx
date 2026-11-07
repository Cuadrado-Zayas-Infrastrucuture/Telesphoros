import { fireEvent, render, screen, within } from '@testing-library/react';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CDR_ELIGIBILITY_POLICY,
  CDR_VOCABULARY_VERSION,
  clinicianDecisionHistoryDtoSchema,
  evaluationDtoSchema,
  evaluationSummaryDtoSchema,
  type ClinicianDecisionHistoryDto,
} from '@telesphoros/shared-types';
import { AssessmentResult } from './AssessmentResult';
import { DecisionPanel } from './patients/DecisionPanel';
import { StoredResult } from './patients/StoredResult';

// Every drug on the FDA Tall Man list shows in its Tall Man form on the result and decision screens, with the plain name kept for
// assistive technology, as the medication list already does (drugPresentation, specs/029-patient-medications D10).

const auth = vi.hoisted(() => ({ apiFetch: vi.fn(), roles: ['clinician'] as string[] }));
vi.mock('@/auth/AuthProvider', () => ({ useAuth: () => auth }));
const history = vi.hoisted(() => ({ value: null as unknown }));
vi.mock('@/lib/clinicianDecisions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/clinicianDecisions')>()),
  readDecisionHistory: async () => history.value,
}));
vi.mock('@/lib/patientFollowups', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/patientFollowups')>()),
  readFollowupAssignees: async () => ({ currentActor: 'clinician-1', items: ['clinician-1'] }),
}));

const fda: { names: string[] } = JSON.parse(readFileSync(resolve(__dirname, '../../../../packages/shared-types/src/drug-list/fda-tall-man.json'), 'utf8'));
const cases = fda.names.map((tall) => ({ tall, plain: tall.toLowerCase() }));

const result = (drug: string) => ({
  id: '55555555-5555-4555-8555-555555555555',
  ordinal: 0,
  drug,
  genes: ['GENEA'],
  outcome: 'shown',
  reasonCode: null,
  strength: 'Strong',
  citation: { guidelineId: 'synthetic-genea' },
  recommendationText: 'Synthetic wording.',
  implication: null,
  geneEvidence: null,
});
const summary = (drug: string) => ({
  id: '66666666-6666-4666-8666-666666666666',
  reportId: '11111111-1111-4111-8111-111111111111',
  patientId: '22222222-2222-4222-8222-222222222222',
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
  results: [result(drug)],
  geneStates: [],
  corrections: [],
  current: true,
  advisory: { activeDisputes: 0, patientLink: 'verified' },
  actionable: false,
  createdAt: '2026-11-04T00:00:00Z',
});
const full = (drug: string) => ({ ...summary(drug), geneInputs: [] });
const decided: ClinicianDecisionHistoryDto = {
  resultId: '55555555-5555-4555-8555-555555555555',
  evaluationId: '66666666-6666-4666-8666-666666666666',
  patientId: '22222222-2222-4222-8222-222222222222',
  basis: ['active'],
  headEntryId: '77777777-7777-4777-8777-777777777777',
  currentDecisionId: '77777777-7777-4777-8777-777777777777',
  entries: [
    {
      id: '77777777-7777-4777-8777-777777777777',
      resultId: '55555555-5555-4555-8555-555555555555',
      evaluationId: '66666666-6666-4666-8666-666666666666',
      patientId: '22222222-2222-4222-8222-222222222222',
      entryKind: 'decision',
      previousEntryId: null,
      response: 'accepted',
      detailCodes: [],
      reviewBy: null,
      vocabularyVersion: CDR_VOCABULARY_VERSION,
      eligibilityPolicy: CDR_ELIGIBILITY_POLICY,
      note: null,
      occurredAt: '2026-11-04T00:00:00Z',
      occurredAtSource: 'recorded',
      createdAt: '2026-11-04T00:00:00Z',
      createdBy: 'clinician-1',
      authorRoles: ['clinician'],
    },
  ],
  clinicalUse: 'not-approved',
  actionable: false,
};

beforeEach(() => {
  auth.roles = ['clinician'];
  history.value = decided;
});

it('the fixtures are a valid evaluation, summary and decision history, so the cases below test the screens', () => {
  expect(() => evaluationDtoSchema.parse(full('tramadol'))).not.toThrow();
  expect(() => evaluationSummaryDtoSchema.parse(summary('tramadol'))).not.toThrow();
  expect(() => clinicianDecisionHistoryDtoSchema.parse(decided)).not.toThrow();
  expect(cases.length).toBeGreaterThan(0);
});

describe.each(cases)('$plain', ({ tall, plain }) => {
  it(`the assessment result shows ${tall}; the section keeps the plain name`, () => {
    render(
      <MemoryRouter>
        <AssessmentResult evaluation={full(plain) as never} created />
      </MemoryRouter>,
    );
    const section = screen.getByRole('region', { name: `Assessment ${plain}` });
    expect(within(section).getByText(tall)).toBeVisible();
  });

  it(`the stored result shows ${tall}; its heading and section keep the plain name`, () => {
    const evaluation = summary(plain) as never;
    render(<StoredResult evaluation={evaluation} result={(evaluation as { results: never[] }).results[0]} followupBusy={false} onFollowup={() => undefined} decisions={false} />);
    const section = screen.getByRole('region', { name: `Stored result ${plain}` });
    const heading = within(section).getByRole('heading', { name: plain });
    expect(heading).toHaveTextContent(tall);
    expect(heading).toBeVisible();
  });

  it(`the linked follow-up names the decision with ${tall}`, async () => {
    const onFollowup = vi.fn();
    const evaluation = summary(plain) as never;
    render(<DecisionPanel evaluation={evaluation} result={(evaluation as { results: never[] }).results[0]} followupBusy={false} onFollowup={onFollowup} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Schedule linked follow-up' }));
    expect(onFollowup).toHaveBeenCalledWith({ id: decided.currentDecisionId, label: `${tall} · Accepted` });
  });
});

it('control: a drug not on the list keeps its plain name', () => {
  render(
    <MemoryRouter>
      <AssessmentResult evaluation={full('warfarin') as never} created />
    </MemoryRouter>,
  );
  expect(within(screen.getByRole('region', { name: 'Assessment warfarin' })).getByText('warfarin')).toBeVisible();
});

// A screen added later cannot print a result's drug name raw: every `{x.drug}` in JSX text goes through drugPresentation. A plain
// name inside a template literal (`${x.drug}`, as in an aria-label) is allowed.
it('no component renders a result drug name as raw JSX text', () => {
  const root = resolve(__dirname, '..');
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (path.endsWith('.tsx') && !/\.test\.tsx$/.test(path)) files.push(path);
    }
  };
  walk(root);
  const raw = files.flatMap((path) =>
    readFileSync(path, 'utf8')
      .split('\n')
      .flatMap((line, index) => (/(?<!\$)\{[\w.?!]+\.drug\}/.test(line) ? [`${relative(root, path)}:${index + 1}`] : [])),
  );
  expect(files.length).toBeGreaterThan(50);
  expect(raw).toEqual([]);
});
