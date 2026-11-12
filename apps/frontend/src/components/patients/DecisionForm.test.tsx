import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { clinicianDecisionHistoryDtoSchema, type ClinicianDecisionHistoryDto } from '@telesphoros/shared-types';
import { PatientLabelContext } from '@/lib/patientLabel';
import { DecisionForm } from './DecisionForm';

const auth = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock('@/auth/AuthProvider', () => ({ useAuth: () => auth }));

const history: ClinicianDecisionHistoryDto = {
  resultId: '55555555-5555-4555-8555-555555555555',
  evaluationId: '66666666-6666-4666-8666-666666666666',
  patientId: '22222222-2222-4222-8222-222222222222',
  basis: ['active'],
  headEntryId: '77777777-7777-4777-8777-777777777777',
  currentDecisionId: null,
  entries: [],
  clinicalUse: 'not-approved',
  actionable: false,
};
const withdraw = (onStale: () => void) => render(<DecisionForm history={history} kind="entered-in-error" onCancel={() => undefined} onSaved={() => undefined} onStale={onStale} />);

beforeEach(() => auth.apiFetch.mockReset());

it('the fixture is a valid decision history', () => {
  expect(() => clinicianDecisionHistoryDtoSchema.parse(history)).not.toThrow();
});

it('a 409 (the result or its history changed) tells the result list to re-read itself', async () => {
  auth.apiFetch.mockResolvedValue(new Response(null, { status: 409 }));
  const onStale = vi.fn();
  withdraw(onStale);
  fireEvent.click(screen.getByRole('button', { name: 'Confirm withdrawal' }));
  expect(await screen.findByText(/The result or decision history changed/)).toBeVisible();
  expect(onStale).toHaveBeenCalledTimes(1);
});

it.each([403, 404])('control: a %i refusal is not a changed result, so the list is not re-read', async (status) => {
  auth.apiFetch.mockResolvedValue(new Response(null, { status }));
  const onStale = vi.fn();
  withdraw(onStale);
  fireEvent.click(screen.getByRole('button', { name: 'Confirm withdrawal' }));
  expect(await screen.findByRole('button', { name: 'Confirm withdrawal' })).toBeDisabled();
  expect(onStale).not.toHaveBeenCalled();
});

// Specs/038 D2: the entry names who and what it is about where it is confirmed. The label is the synthetic one the page carries.
it('names the patient and the drug on the form that records the decision', () => {
  render(
    <PatientLabelContext.Provider value="SYN-004">
      <DecisionForm history={history} kind="decision" subject="drugz" onCancel={() => undefined} onSaved={() => undefined} onStale={() => undefined} />
    </PatientLabelContext.Provider>,
  );
  expect(screen.getByText('For patient SYN-004 · drugz')).toBeVisible();
});

it('control: away from a patient page the form names only what it was given, and invents no patient', () => {
  render(<DecisionForm history={history} kind="decision" subject="drugz" onCancel={() => undefined} onSaved={() => undefined} onStale={() => undefined} />);
  expect(screen.getByText('For drugz')).toBeVisible();
  expect(screen.queryByText(/patient/i)).not.toBeInTheDocument();
});
