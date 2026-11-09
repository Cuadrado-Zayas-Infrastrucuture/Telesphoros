import { describe, expect, it } from 'vitest';
import { evaluationStanding } from './resultStatus';

const CHANGED = 'The guidelines have changed since this result was made. A pharmacist must check whether it still applies.';
const UNKNOWN = 'Could not confirm that this result used the guidelines in use now.';
type Knowledge = { evaluatedWith: string; loadedNow: string | null; status: 'same' | 'changed' | 'unknown' } | undefined;

const standing = (knowledge: Knowledge, change: { state?: 'active' | 'retracted' | 'superseded'; current?: boolean } = {}) =>
  evaluationStanding({ state: change.state ?? 'active', current: change.current ?? true, advisory: { activeDisputes: 0, patientLink: 'verified', knowledge } });
const messages = (knowledge: Knowledge, change?: Parameters<typeof standing>[1]) => standing(knowledge, change).notices.map((notice) => notice.message);

describe('evaluationStanding: the guidelines a result used', () => {
  it('says nothing while they are the ones in use', () => {
    expect(standing({ evaluatedWith: 'a', loadedNow: 'a', status: 'same' })).toEqual({ notices: [], fold: false });
  });

  it('warns when they have changed, and leaves the result readable', () => {
    expect(standing({ evaluatedWith: 'a', loadedNow: 'b', status: 'changed' })).toEqual({ notices: [{ tone: 'warning', message: CHANGED }], fold: false });
  });

  it('warns that it could not confirm them when that cannot be compared, or the API is older than this screen', () => {
    expect(messages({ evaluatedWith: 'a', loadedNow: null, status: 'unknown' })).toEqual([UNKNOWN]);
    expect(messages(undefined)).toEqual([UNKNOWN]);
  });

  it('adds nothing to a result that already says not to use it', () => {
    const changed = { evaluatedWith: 'a', loadedNow: 'b', status: 'changed' } as const;
    expect(messages(changed, { current: false })).toEqual(['Not the current result for this report.']);
    expect(messages(changed, { state: 'retracted' })).toEqual(['Withdrawn. Do not use this result.']);
    expect(messages(changed, { state: 'superseded' })).toEqual(['Replaced by a newer result. Do not use this one.']);
  });
});
