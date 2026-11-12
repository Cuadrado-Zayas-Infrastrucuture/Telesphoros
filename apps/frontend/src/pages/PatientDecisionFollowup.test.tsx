import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, it, vi } from 'vitest';
import {
  CDR_CODE_LABELS,
  CDR_ELIGIBILITY_POLICY,
  CDR_NOTE_REQUIRED_CODES,
  CDR_REASON_CODES,
  CDR_VOCABULARY_VERSION,
  clinicianDecisionDtoSchema,
  evaluationSummaryDtoSchema,
  followupDtoSchema,
  patientMedicationDtoSchema,
} from '@telesphoros/shared-types';
import { RECOVERY_SCOPE, renderApp } from '@/test/authTestUtils';

// Specs/038 D14, through the real patient page, forms and API clients; only the HTTP boundary is a stand-in, so this proves the browser's
// side of the flow and nothing about the API. One synthetic patient, one current recommendation, its evidence, a decision, and the
// follow-up scheduled for it as a second, separate save. Every identifier and value is synthetic.

const PATIENT = '0f8fad5b-d9cb-469f-a165-70867728950e';
const EVALUATION = '66666666-6666-4666-8666-666666666666';
const RESULT = '55555555-5555-4555-8555-555555555555';
const MEDICATION = '77777777-7777-4777-8777-777777777777';
const NOW = '2026-11-12T12:00:00.000Z';
const REASON = CDR_REASON_CODES.find((code) => !(CDR_NOTE_REQUIRED_CODES as readonly string[]).includes(code))!;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const evaluation = {
  id: EVALUATION,
  reportId: '11111111-1111-4111-8111-111111111111',
  patientId: PATIENT,
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
      id: RESULT,
      ordinal: 0,
      drug: 'drugz',
      genes: ['GENEA'],
      outcome: 'shown',
      reasonCode: null,
      strength: 'Strong',
      citation: {
        guidelineId: 'syn-guideline-drugz',
        guidelineVersion: 'synthetic-3',
        locator: { table: 'Synthetic Table 2', row: 'Poor Metabolizer', column: null },
        verification: 'verified',
      },
      recommendationText: 'Z normal-low.',
      implication: null,
      geneEvidence: null,
    },
  ],
  geneStates: [{ gene: 'GENEA', state: 'canonical', phenotype: 'Poor Metabolizer', diplotype: '*2/*3', activityScore: '0.0', reasonCode: null }],
  corrections: [],
  current: true,
  advisory: { activeDisputes: 0, patientLink: 'verified', knowledge: { evaluatedWith: 'set', loadedNow: 'set', status: 'same' } },
  actionable: false,
  createdAt: '2026-11-04T00:00:00Z',
};
const medication = {
  id: MEDICATION,
  entryId: '88888888-8888-4888-8888-888888888888',
  patientId: PATIENT,
  version: 1,
  current: true,
  rxcui: '123',
  listVersion: 'b'.repeat(64),
  status: 'active',
  startMonth: null,
  stopMonth: null,
  source: 'clinician-entered',
  name: 'drugz',
  createdAt: NOW,
  createdBy: 'person-1',
};

/** A stored decision as the API sends it: the stand-in's own request id (how it recognises a retry) is not part of the DTO. */
const dto = (stored: Record<string, unknown>) => Object.fromEntries(Object.entries(stored).filter(([key]) => key !== 'requestId'));

type Reply = Response | 'lost';
interface Stub {
  /** What each decision POST answers, in order; `stored` once exhausted. */
  decisionReplies: Array<Reply | 'stored'>;
  /** What each follow-up POST answers, in order; `stored` once exhausted. */
  followupReplies: Array<Response | 'stored'>;
  recording: 'enabled' | 'paused';
}
function server(options: Partial<Stub> = {}) {
  const stub: Stub = { decisionReplies: [], followupReplies: [], recording: 'enabled', ...options };
  const decisions: Array<Record<string, unknown>> = [];
  const posts = { decision: [] as Array<Record<string, unknown>>, followup: [] as Array<Record<string, unknown>> };
  const followups: Array<Record<string, unknown>> = [];
  const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
    const at = new URL(String(url), 'http://synthetic');
    const post = init?.method === 'POST';
    if (at.pathname === `/api/v1/evaluation-results/${RESULT}/clinician-decisions`) {
      if (post) {
        const body = JSON.parse(String(init!.body)) as Record<string, unknown>;
        posts.decision.push(body);
        const reply = stub.decisionReplies.shift() ?? 'stored';
        if (reply !== 'stored' && reply !== 'lost') return reply;
        // An idempotent write: the same request id stores one entry, however many times it arrives.
        let stored = decisions.find((entry) => entry.requestId === body.requestId);
        if (!stored) {
          stored = {
            requestId: body.requestId,
            id: `99999999-9999-4999-8999-99999999999${decisions.length}`,
            resultId: RESULT,
            evaluationId: EVALUATION,
            patientId: PATIENT,
            entryKind: body.entryKind,
            previousEntryId: body.previousEntryId,
            response: body.response,
            detailCodes: body.detailCodes,
            reviewBy: body.reviewBy,
            vocabularyVersion: CDR_VOCABULARY_VERSION,
            eligibilityPolicy: CDR_ELIGIBILITY_POLICY,
            note: null,
            occurredAt: NOW,
            occurredAtSource: 'recorded',
            createdAt: NOW,
            createdBy: 'person-1',
            authorRoles: ['clinician'],
          };
          decisions.push(stored);
        }
        if (reply === 'lost') throw new TypeError('synthetic lost reply');
        return json(dto(stored), 201);
      }
      const entries = decisions.map(dto);
      return json({
        resultId: RESULT,
        evaluationId: EVALUATION,
        patientId: PATIENT,
        basis: ['active'],
        headEntryId: entries.at(-1)?.id ?? null,
        currentDecisionId: entries[0]?.id ?? null,
        entries,
        clinicalUse: 'not-approved',
        actionable: false,
      });
    }
    if (at.pathname === '/api/v1/evaluations') return json({ data: [evaluation], meta: { page: 1, pageSize: 10, total: 1, totalPages: 1 } });
    if (at.pathname === '/api/v1/result-renders') return json({ stored: 0, duplicates: 0 });
    if (at.pathname === '/api/v1/followups/availability') return json({ recording: stub.recording });
    if (at.pathname === '/api/v1/followups/assignees') return json({ currentActor: 'person-1', items: ['person-1'] });
    if (at.pathname === `/api/v1/patients/${PATIENT}/followups` && post) {
      const body = JSON.parse(String(init!.body)) as Record<string, unknown>;
      posts.followup.push(body);
      const reply = stub.followupReplies.shift() ?? 'stored';
      if (reply !== 'stored') return reply;
      const saved = {
        id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        threadId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        patientId: PATIENT,
        patientLabel: 'SYN-FLOW',
        medicationId: body.medicationId,
        medicationName: 'drugz',
        decisionId: body.decisionId,
        version: 1,
        action: 'schedule',
        assessment: null,
        note: body.note,
        noteRedacted: false,
        next: body.next,
        createdAt: NOW,
        createdBy: 'person-1',
        current: true,
        dueState: 'upcoming',
        needsReassignment: false,
      };
      followups.push(saved);
      return json(saved, 201);
    }
    if (at.pathname.endsWith('/followups'))
      return json({ currentActor: 'person-1', items: followups, page: 1, hasMore: false, counts: { overdue: 0, today: 0, upcoming: followups.length, unassigned: 0 } });
    if (at.pathname.endsWith('/medications')) return json({ items: [medication] });
    if (at.pathname.endsWith('/demographics')) return json({ error: { details: [{ reason: 'no-demographics' }] } }, 404);
    if (at.pathname === `/api/v1/patients/${PATIENT}`) return json({ id: PATIENT, label: 'SYN-FLOW', createdAt: NOW, updatedAt: NOW, mergedInto: null });
    if (at.pathname.endsWith('/me/recovery-scope')) return json({ recoveryScope: RECOVERY_SCOPE });
    if (at.pathname.includes('/patients') || at.pathname.includes('/reports')) return json({ data: [], meta: { page: 1, pageSize: 20, total: 0, totalPages: 0 } });
    return json({ roles: ['clinician'] });
  });
  return { fetchImpl, posts, decisions, followups };
}

async function openResult(stub: ReturnType<typeof server>) {
  renderApp(`/patients/${PATIENT}`, { signedInAs: ['clinician'], fetchImpl: stub.fetchImpl });
  return within(await screen.findByRole('region', { name: 'Stored result drugz' }));
}
/** Fills a deferral with a review-by date, optionally asking for the follow-up step, and saves. */
async function deferDecision(result: ReturnType<typeof within>, options: { followup: boolean }) {
  await userEvent.click(await result.findByRole('button', { name: 'Record decision' }));
  const form = within(result.getByRole('form', { name: 'Record decision' }));
  await userEvent.selectOptions(form.getByRole('combobox', { name: 'Decision' }), 'deferred');
  await userEvent.click(form.getByLabelText(CDR_CODE_LABELS[REASON]));
  fireEvent.change(form.getByLabelText(/^Review by \(optional\)/), { target: { value: '2099-02-01' } });
  if (options.followup) await userEvent.click(form.getByRole('checkbox', { name: 'Then schedule a linked follow-up (optional)' }));
  await userEvent.click(form.getByRole('button', { name: 'Save decision' }));
  return form;
}
const followupForm = async () => within(await screen.findByRole('form', { name: 'Schedule follow-up' }));
async function fillFollowup(form: ReturnType<typeof within>) {
  await userEvent.selectOptions(await form.findByRole('combobox', { name: 'Recorded medication' }), MEDICATION);
  await userEvent.type(form.getByRole('textbox', { name: 'Reason or treatment goal' }), 'Synthetic check after the deferral.');
}

beforeEach(() => {
  vi.clearAllMocks();
  // jsdom has no layout, so it has no scrollIntoView; the follow-up section calls it when a linked form opens.
  Element.prototype.scrollIntoView = vi.fn();
});

it('the fixtures are valid, so the cases below test the page and not the fixtures', () => {
  expect(() => evaluationSummaryDtoSchema.parse(evaluation)).not.toThrow();
  expect(() => patientMedicationDtoSchema.parse(medication)).not.toThrow();
});

it('one patient, one current recommendation, its evidence, a decision and its follow-up: two saves, each reported, the failed one retried alone', async () => {
  const stub = server({ followupReplies: [json({ error: { code: 'UNAVAILABLE' } }, 503)] });
  const result = await openResult(stub);
  // The result, its wording and its evidence are on the page without a click.
  expect(await result.findByText('Z normal-low.')).toBeVisible();
  const evidence = within(result.getByRole('complementary', { name: 'Evidence for drugz' }));
  expect(evidence.getByText(/GENEA: Poor Metabolizer/)).toBeVisible();
  expect(evidence.getByText('syn-guideline-drugz · version synthetic-3')).toBeVisible();

  await deferDecision(result, { followup: true });
  await waitFor(() => expect(stub.posts.decision).toHaveLength(1));
  expect(stub.posts.decision[0]).toMatchObject({ patientId: PATIENT, evaluationId: EVALUATION, response: 'deferred', reviewBy: '2099-02-01' });

  // Step 2 opens for the decision the server stored, with the review-by date offered as the follow-up's date.
  const followup = await followupForm();
  expect(followup.getByText(/Step 2 of 2\. The decision is already saved\./)).toBeVisible();
  expect(followup.getByText(/Linked decision: drugz · Deferred/)).toBeVisible();
  expect(await followup.findByLabelText('Next follow-up date')).toHaveValue('2099-02-01');
  expect(await result.findByText('Current decision: Deferred')).toBeVisible();
  await fillFollowup(followup);

  // The follow-up save fails. The decision stays saved, and the form says both.
  await userEvent.click(followup.getByRole('button', { name: 'Schedule follow-up' }));
  expect(await followup.findByRole('alert')).toHaveTextContent('Follow-up recording is unavailable. Your draft is kept; retry later.');
  expect(followup.getByText(/Step 2 of 2\. The decision is already saved\./)).toBeVisible();
  expect(followup.getByRole('textbox', { name: 'Reason or treatment goal' })).toHaveValue('Synthetic check after the deferral.');
  expect(stub.posts.decision).toHaveLength(1);

  // Retrying sends only the follow-up, as the same request.
  await userEvent.click(followup.getByRole('button', { name: 'Schedule follow-up' }));
  expect(await screen.findByText('Decision saved. Follow-up saved.')).toBeVisible();
  expect(stub.posts.followup).toHaveLength(2);
  expect(stub.posts.followup[1]!.requestId).toBe(stub.posts.followup[0]!.requestId);
  expect(stub.posts.followup[1]).toMatchObject({ action: 'schedule', medicationId: MEDICATION, decisionId: stub.decisions[0]!.id, next: { date: '2099-02-01' } });
  expect(stub.posts.decision).toHaveLength(1);
  expect(stub.followups).toHaveLength(1);
  // The stand-in answered with what the real schemas accept.
  expect(() => followupDtoSchema.parse(stub.followups[0])).not.toThrow();
  expect(() => clinicianDecisionDtoSchema.parse(dto(stub.decisions[0]!))).not.toThrow();
});

it('cancelling the follow-up step leaves the decision saved and says no reminder exists, with focus on that line', async () => {
  const stub = server();
  const result = await openResult(stub);
  await deferDecision(result, { followup: true });
  const followup = await followupForm();
  await userEvent.click(followup.getByRole('button', { name: 'Cancel' }));
  const line = await screen.findByText('Decision saved. No follow-up was scheduled, so no reminder exists for it.');
  expect(line).toBeVisible();
  await waitFor(() => expect(line).toHaveFocus());
  expect(await result.findByText('Current decision: Deferred')).toBeVisible();
  expect(stub.posts.decision).toHaveLength(1);
  expect(stub.posts.followup).toHaveLength(0);
  // The ordinary way to schedule it later is still there.
  expect(result.getByRole('button', { name: 'Schedule linked follow-up' })).toBeEnabled();
});

it('control: a decision saved without asking for a follow-up opens no second step', async () => {
  const stub = server();
  const result = await openResult(stub);
  await deferDecision(result, { followup: false });
  expect(await result.findByText('Decision saved.')).toBeVisible();
  expect(await result.findByText('Current decision: Deferred')).toBeVisible();
  expect(screen.queryByRole('form', { name: 'Schedule follow-up' })).not.toBeInTheDocument();
  expect(screen.queryByText(/^Decision saved\. (Follow-up saved|No follow-up)/)).not.toBeInTheDocument();
  expect(stub.posts.followup).toHaveLength(0);
});

it('a lost decision reply starts no follow-up; the retry is the same request, stores one decision, and only then opens step 2', async () => {
  const stub = server({ decisionReplies: ['lost'] });
  const result = await openResult(stub);
  const form = await deferDecision(result, { followup: true });
  expect(await form.findByRole('alert')).toHaveTextContent('Save was not confirmed. Your exact entry is kept for retry.');
  expect(screen.queryByRole('form', { name: 'Schedule follow-up' })).not.toBeInTheDocument();
  await userEvent.click(form.getByRole('button', { name: 'Retry save' }));
  const followup = await followupForm();
  expect(followup.getByText(/Linked decision: drugz · Deferred/)).toBeVisible();
  expect(stub.posts.decision).toHaveLength(2);
  expect(stub.posts.decision[1]!.requestId).toBe(stub.posts.decision[0]!.requestId);
  expect(stub.decisions).toHaveLength(1);
});

it('a decision refused because the result changed (409) saves nothing and starts no follow-up', async () => {
  const stub = server({ decisionReplies: [json({ error: { code: 'CONFLICT' } }, 409)] });
  const result = await openResult(stub);
  const form = await deferDecision(result, { followup: true });
  expect(await form.findByRole('alert')).toHaveTextContent(/The result or decision history changed/);
  expect(stub.decisions).toHaveLength(0);
  expect(screen.queryByRole('form', { name: 'Schedule follow-up' })).not.toBeInTheDocument();
  expect(stub.posts.followup).toHaveLength(0);
});

it('a double click on Save sends one decision', async () => {
  const stub = server();
  const result = await openResult(stub);
  await userEvent.click(await result.findByRole('button', { name: 'Record decision' }));
  const form = within(result.getByRole('form', { name: 'Record decision' }));
  await userEvent.selectOptions(form.getByRole('combobox', { name: 'Decision' }), 'accepted');
  const save = form.getByRole('button', { name: 'Save decision' });
  fireEvent.click(save);
  fireEvent.click(save);
  expect(await result.findByText('Current decision: Accepted')).toBeVisible();
  expect(stub.posts.decision).toHaveLength(1);
});

it('where follow-up recording is paused, the decision form offers no second step and says why', async () => {
  const stub = server({ recording: 'paused' });
  const result = await openResult(stub);
  await userEvent.click(await result.findByRole('button', { name: 'Record decision' }));
  const form = within(result.getByRole('form', { name: 'Record decision' }));
  expect(await form.findByText('Follow-up recording is not available in this environment, so no reminder can be created for this decision here.')).toBeVisible();
  expect(form.queryByRole('checkbox', { name: 'Then schedule a linked follow-up (optional)' })).not.toBeInTheDocument();
});

it('the decision form names its patient and drug, and says the review-by date creates no reminder', async () => {
  const stub = server();
  const result = await openResult(stub);
  await userEvent.click(await result.findByRole('button', { name: 'Record decision' }));
  const form = within(result.getByRole('form', { name: 'Record decision' }));
  expect(form.getByText('For patient SYN-FLOW · drugz')).toBeVisible();
  await userEvent.selectOptions(form.getByRole('combobox', { name: 'Decision' }), 'deferred');
  expect(form.getByText('This records the intended review date only. It creates no reminder: only a linked follow-up does.')).toBeVisible();
});

it('a reviewer reads the result, its evidence and the decision history, and is offered no way to record', async () => {
  const stub = server();
  renderApp(`/patients/${PATIENT}`, {
    signedInAs: ['reviewer'],
    fetchImpl: vi.fn<typeof fetch>(async (url, init) => {
      const at = new URL(String(url), 'http://synthetic');
      return at.pathname === '/api/v1/me' ? json({ roles: ['reviewer'] }) : stub.fetchImpl(url, init);
    }),
  });
  const result = within(await screen.findByRole('region', { name: 'Stored result drugz' }));
  expect(await result.findByText('No decisions recorded.')).toBeVisible();
  expect(result.getByRole('complementary', { name: 'Evidence for drugz' })).toBeVisible();
  expect(result.queryByRole('button', { name: 'Record decision' })).not.toBeInTheDocument();
  expect(result.queryByRole('form')).not.toBeInTheDocument();
});
