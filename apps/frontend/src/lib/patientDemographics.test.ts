import { describe, expect, it, vi } from 'vitest';
import { SubmitError } from './api';
import { getCompleteness, getDemographics, recordDemographics } from './patientDemographics';

const ID = '0f8fad5b-d9cb-469f-a165-70867728950e';
const VALUE = {
  patientId: ID,
  version: 1,
  current: true,
  givenName: 'Zzyzx-Synthetic',
  familyName: 'Núñez-Testcase',
  dateOfBirth: '1980-02-29',
  sex: 'female',
  birthYear: 1980,
  ageYears: 46,
  ethnicity: ['white'],
  createdAt: '2026-10-31T12:00:00.000Z',
  createdBy: 'person-1',
  versions: [{ version: 1, createdAt: '2026-10-31T12:00:00.000Z', createdBy: 'person-1', sex: 'female', birthYear: 1980, ethnicity: ['white'] }],
};
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const refusal = (status: number, reason: string) => json(status, { error: { code: 'X', message: 'm', details: [{ field: 'request', message: 'm', reason }] } });

describe('getDemographics', () => {
  it('reads the current version, or ?version=N', async () => {
    const api = vi.fn<(path: string, init?: RequestInit) => Promise<Response>>(async () => json(200, VALUE));
    expect(await getDemographics(api, ID)).toEqual({ kind: 'found', value: VALUE });
    await getDemographics(api, ID, 3);
    expect(api.mock.calls.map((call) => call[0])).toEqual([`/api/v1/patients/${ID}/demographics`, `/api/v1/patients/${ID}/demographics?version=3`]);
  });

  it('turns 404 no-demographics into "none" and 410 identity-erased into "erased"; a missing version is an error, not "none"', async () => {
    expect(
      await getDemographics(
        vi.fn(async () => refusal(404, 'no-demographics')),
        ID,
      ),
    ).toEqual({ kind: 'none' });
    expect(
      await getDemographics(
        vi.fn(async () => refusal(410, 'identity-erased')),
        ID,
      ),
    ).toEqual({ kind: 'erased' });
    await expect(
      getDemographics(
        vi.fn(async () => refusal(404, 'no-demographics')),
        ID,
        9,
      ),
    ).rejects.toThrow('That version does not exist.');
    await expect(
      getDemographics(
        vi.fn(async () => json(404, {})),
        ID,
      ),
    ).rejects.toThrow('This patient is not available.');
  });

  it('never shows a transport error or a response payload', async () => {
    const promise = getDemographics(
      vi.fn(async () => Promise.reject(new Error('socket Zzyzx-Synthetic'))),
      ID,
    );
    await expect(promise).rejects.toBeInstanceOf(SubmitError);
    await expect(promise).rejects.not.toThrow(/Zzyzx/);
  });
});

describe('recordDemographics', () => {
  const input = { givenName: 'Zzyzx-Synthetic', familyName: 'Núñez-Testcase', dateOfBirth: '1980-02-29', sex: 'female' as const, ethnicity: ['white' as const] };

  it('posts the version with its request id', async () => {
    const api = vi.fn<(path: string, init?: RequestInit) => Promise<Response>>(async () => json(201, VALUE));
    await recordDemographics(api, ID, input, '11111111-1111-4111-8111-111111111111');
    const [path, init] = api.mock.calls[0]!;
    expect(path).toBe(`/api/v1/patients/${ID}/demographics`);
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({ ...input, requestId: '11111111-1111-4111-8111-111111111111' });
  });

  it('names each refusal in fixed text that never contains a submitted value', async () => {
    const cases: [Response, RegExp][] = [
      [refusal(409, 'request-id-reused'), /already used/],
      [refusal(410, 'identity-erased'), /erased/],
      [json(403, {}), /role/],
      [json(422, {}), /not accepted/],
      [json(503, {}), /right now/],
    ];
    for (const [response, message] of cases) {
      const promise = recordDemographics(
        vi.fn(async () => response),
        ID,
        input,
        '11111111-1111-4111-8111-111111111111',
      );
      await expect(promise).rejects.toThrow(message);
      await expect(promise).rejects.not.toThrow(/Zzyzx|Núñez|1980/);
    }
  });
});

describe('getCompleteness (spec 025 T304)', () => {
  const COUNTS = { patients: 4, complete: 1, incomplete: 2, none: 1 };

  it('reads the counts from the counts route', async () => {
    const api = vi.fn<(path: string, init?: RequestInit) => Promise<Response>>(async () => json(200, COUNTS));
    expect(await getCompleteness(api)).toEqual(COUNTS);
    expect(api.mock.calls[0]![0]).toBe('/api/v1/patients/demographics-completeness');
  });

  it('answers with fixed text and closes the request when the route refuses: the unread error body is discarded', async () => {
    const response = json(503, { error: { code: 'X', message: 'Zzyzx-Synthetic' } });
    const cancel = vi.spyOn(response.body!, 'cancel');
    const promise = getCompleteness(vi.fn(async () => response));
    await expect(promise).rejects.toThrow('The demographics counts could not be loaded.');
    await expect(promise).rejects.not.toThrow(/Zzyzx/);
    expect(cancel).toHaveBeenCalled(); // an open body kept the browser's network busy and failed every page that waits for it to settle
  });

  it('refuses an answer whose counts do not add up', async () => {
    await expect(getCompleteness(vi.fn(async () => json(200, { ...COUNTS, patients: 9 })))).rejects.toThrow('could not be loaded');
  });
});
