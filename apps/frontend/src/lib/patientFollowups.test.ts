import type { FollowupInput } from '@telesphoros/shared-types';
import { describe, expect, it, vi } from 'vitest';
import { SubmitError } from './api';
import { FOLLOWUPS_PAUSED_MESSAGE, readFollowupAvailability, recordFollowup } from './patientFollowups';

const PATIENT = '0f8fad5b-d9cb-469f-a165-70867728950e';
const MEDICATION = '1f8fad5b-d9cb-469f-a165-70867728950e';
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const api = (response: () => Response) => vi.fn<(path: string, init?: RequestInit) => Promise<Response>>(async () => response());
const input: FollowupInput = {
  requestId: '2f8fad5b-d9cb-469f-a165-70867728950e',
  action: 'schedule',
  medicationId: MEDICATION,
  decisionId: null,
  assessment: null,
  note: 'Synthetic treatment follow-up',
  next: { date: '2026-12-01', timezone: 'America/Puerto_Rico', assignee: 'person-1' },
};

describe('readFollowupAvailability', () => {
  it('reports what the API says', async () => {
    const enabled = api(() => json(200, { recording: 'enabled' }));
    expect(await readFollowupAvailability(enabled)).toBe('enabled');
    expect(enabled.mock.calls[0]![0]).toBe('/api/v1/followups/availability');
    expect(await readFollowupAvailability(api(() => json(200, { recording: 'paused' })))).toBe('paused');
  });
  it("is 'unknown', never 'paused', when the answer cannot be had", async () => {
    // An API released before this read existed answers 404; the page must keep working as it did.
    expect(await readFollowupAvailability(api(() => json(404, { error: {} })))).toBe('unknown');
    expect(await readFollowupAvailability(api(() => json(200, { roles: ['clinician'] })))).toBe('unknown');
    expect(await readFollowupAvailability(api(() => json(200, { recording: 'sometimes' })))).toBe('unknown');
    const offline = vi.fn<(path: string, init?: RequestInit) => Promise<Response>>(async () => {
      throw new Error('DO-NOT-ECHO');
    });
    expect(await readFollowupAvailability(offline)).toBe('unknown');
  });
});

describe('recordFollowup, refused with 503', () => {
  const refused = (reason?: string) => api(() => json(503, { error: { message: 'DO-NOT-ECHO', details: reason ? [{ field: 'request', reason }] : [] } }));
  it('says recording is not available here when the API names the pause, and does not say to retry', async () => {
    const error = await recordFollowup(refused('followup-writes-paused'), PATIENT, input).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SubmitError);
    expect((error as SubmitError).message).toContain(FOLLOWUPS_PAUSED_MESSAGE);
    expect((error as SubmitError).message).not.toMatch(/retry/i);
    expect((error as SubmitError).message).not.toContain('DO-NOT-ECHO');
  });
  it('keeps the retry wording for any other 503', async () => {
    const error = await recordFollowup(refused(), PATIENT, input).catch((caught: unknown) => caught);
    expect((error as SubmitError).message).toBe('Follow-up recording is unavailable. Your draft is kept; retry later.');
  });
});
