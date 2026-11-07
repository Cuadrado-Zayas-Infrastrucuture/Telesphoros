import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as contracts from './index';
import type { SyntheticPgxPackage } from './synthetic-pgx';

const tenantId = '11111111-1111-4111-8111-111111111111';
const patientId = '22222222-2222-4222-8222-222222222222';
const otherId = '33333333-3333-4333-8333-333333333333';
const sourceId = (n: number) => `44444444-4444-4444-8444-${String(n).padStart(12, '0')}`;
const fixture = (): SyntheticPgxPackage => JSON.parse(readFileSync(new URL('../../../data/fixtures/pgx-contracts/resolved/package.json', import.meta.url), 'utf8'));
function source(n = 1, revision = 1) {
  const report = fixture().report;
  Object.assign(report, {
    id: `syn-report-${revision}`,
    revision,
    previousRevisionId: revision === 1 ? null : `syn-report-${revision - 1}`,
    status: revision === 1 ? 'final' : 'amended',
    issuedAt: `2026-11-${String(revision + 1).padStart(2, '0')}T12:00:00Z`,
    receivedAt: '2026-11-20T12:00:00Z',
  });
  return { sourceId: sourceId(n), tenantId, patientId, sha256: String(revision).repeat(64), objectVersion: `object-${n}`, report };
}
const inspect = (sources: ReturnType<typeof source>[]) => contracts.inspectSyntheticPgxLineage({ tenantId, patientId, sources });
const group = (sources: ReturnType<typeof source>[]) => inspect(sources).series[0];

describe('synthetic report revision inspection', () => {
  it('exports the inspection boundary without an application or engine dependency', () => {
    expect(contracts).toHaveProperty('inspectSyntheticPgxLineage');
  });
  it('keeps a valid final source as a non-actionable candidate requiring independent review', () => {
    const s = source();
    const result = inspect([s]);
    expect(result).toMatchObject({
      policyVersion: 'pgx-lineage-synthetic-0.1',
      synthetic: true,
      clinicalUse: 'not-approved',
      actionable: false,
      independentReviewRequired: true,
      profileState: 'not-reconciled',
    });
    expect(result.series).toEqual([
      {
        laboratoryId: s.report.laboratoryId,
        seriesId: s.report.seriesId,
        state: 'candidate-for-review',
        reasons: [],
        revisions: [{ revision: 1, reportIds: ['syn-report-1'], sources: [{ sourceId: sourceId(1), sha256: '1'.repeat(64), objectVersion: 'object-1' }] }],
        candidate: { reportId: 'syn-report-1', revision: 1, sourceIds: [sourceId(1)], findingIds: ['syn-finding-a'] },
      },
    ]);
  });
  it('deduplicates identical source bytes across uploads while retaining both exact source references', () => {
    const a = source();
    const b = source(2);
    expect(group([b, a]).revisions[0].sources).toEqual([
      { sourceId: sourceId(1), sha256: '1'.repeat(64), objectVersion: 'object-1' },
      { sourceId: sourceId(2), sha256: '1'.repeat(64), objectVersion: 'object-2' },
    ]);
    expect(group([a, b]).candidate?.sourceIds).toEqual([sourceId(1), sourceId(2)]);
  });
  it.each(['hash', 'content'])('holds changed %s at the same revision instead of choosing an upload', (change) => {
    const a = source();
    const b = source(2);
    if (change === 'hash') b.sha256 = 'a'.repeat(64);
    else b.report.limitations = ['Different source content despite a claimed equal hash.'];
    expect(group([a, b])).toMatchObject({ state: 'held', reasons: ['duplicate-revision-content'], candidate: null });
  });
  it('rejects the entire snapshot before returning foreign tenant or patient evidence', () => {
    for (const key of ['tenantId', 'patientId'] as const) {
      const foreign = source(2);
      foreign[key] = otherId;
      expect(() => inspect([source(), foreign])).toThrow('Invalid synthetic lineage snapshot.');
    }
    expect(group([source()]).state).toBe('candidate-for-review');
  });
  it('selects only revision 2 references from a complete amendment chain, retaining original history', () => {
    const second = source(2, 2);
    second.report.findings = [];
    expect(group([second, source()])).toMatchObject({
      state: 'candidate-for-review',
      reasons: [],
      revisions: [{ revision: 1 }, { revision: 2 }],
      candidate: { reportId: 'syn-report-2', revision: 2, sourceIds: [sourceId(2)], findingIds: [] },
    });
  });
  it.each([
    ['missing first revision', () => [source(2, 2)], 'revision-gap'],
    ['missing intermediate revision', () => [source(), source(3, 3)], 'revision-gap'],
    [
      'wrong predecessor',
      () => {
        const s = source(2, 2);
        s.report.previousRevisionId = 'syn-unrelated';
        return [source(), s];
      },
      'predecessor-mismatch',
    ],
    [
      'source patient drift',
      () => {
        const s = source(2, 2);
        s.report.patientId = 'syn-other-patient';
        return [source(), s];
      },
      'source-patient-mismatch',
    ],
    [
      'accession drift',
      () => {
        const s = source(2, 2);
        s.report.accession = 'syn-other-accession';
        return [source(), s];
      },
      'accession-mismatch',
    ],
    [
      'specimen drift',
      () => {
        const s = source(2, 2);
        s.report.specimen.id = 'syn-other-specimen';
        return [source(), s];
      },
      'specimen-mismatch',
    ],
    [
      'issue time reversal',
      () => {
        const s = source(2, 2);
        s.report.issuedAt = '2026-11-02T11:00:00Z';
        return [source(), s];
      },
      'issue-time-reversal',
    ],
  ] as const)('holds %s', (_label, sources, reason) => {
    expect(group(sources())).toMatchObject({ state: 'held', candidate: null });
    expect(group(sources()).reasons).toContain(reason);
    expect(group([source(), source(2, 2)]).state).toBe('candidate-for-review');
  });
  it.each(['preliminary', 'cancelled', 'entered-in-error'] as const)('never falls back when the latest revision is %s', (status) => {
    const second = source(2, 2);
    second.report.status = status;
    expect(group([source(), second])).toMatchObject({ state: 'held', reasons: ['latest-status-ineligible'], candidate: null });
  });
  it.each(['cancelled', 'entered-in-error'] as const)('holds a successor to a %s revision pending explicit reconciliation', (status) => {
    const first = source();
    first.report.status = status;
    expect(group([first, source(2, 2)]).reasons).toContain('terminal-revision-has-successor');
  });
  it('holds a reused report ID across revisions even with different content hashes', () => {
    const third = source(3, 3);
    third.report.id = 'syn-report-1';
    expect(group([source(), source(2, 2), third])).toMatchObject({ state: 'held', candidate: null });
    expect(group([source(), source(2, 2), third]).reasons).toContain('report-id-reused');
  });
  it.each(['report', 'accession'])('holds both series when one laboratory reuses a %s identity', (identity) => {
    const other = source(2);
    other.report.seriesId = 'syn-other-series';
    if (identity === 'report') other.report.accession = 'syn-other-accession';
    else other.report.id = 'syn-other-report';
    const result = inspect([source(), other]);
    expect(result.series).toHaveLength(2);
    for (const s of result.series) expect(s).toMatchObject({ state: 'held', reasons: [identity === 'report' ? 'report-id-reused' : 'accession-reused'], candidate: null });
  });
  it('keeps laboratories separate even if their external identifiers match', () => {
    const other = source(2);
    other.report.laboratoryId = 'syn-other-laboratory';
    if (other.report.assay.state === 'provided') other.report.assay.manifest.laboratoryId = other.report.laboratoryId;
    const result = inspect([source(), other]);
    expect(result.series.map((s) => s.state)).toEqual(['candidate-for-review', 'candidate-for-review']);
    expect(result.profileState).toBe('not-reconciled');
  });
  it('holds conflicting branches without choosing the later timestamp', () => {
    const branch = source(3, 2);
    branch.report.id = 'syn-branch';
    branch.report.issuedAt = '2026-11-04T12:00:00Z';
    expect(group([source(), source(2, 2), branch])).toMatchObject({ state: 'held', candidate: null });
    expect(group([source(), source(2, 2), branch]).reasons).toContain('duplicate-revision-content');
  });
  it('names same-revision conflicts without choosing a source, and ignores identical re-uploads', () => {
    const find = (sources: ReturnType<typeof source>[]) => contracts.findSyntheticPgxRevisionConflicts({ tenantId, patientId, sources });
    const a = source();
    const twin = source(2);
    expect(find([a, twin])).toEqual([]);
    const changedHash = source(3);
    changedHash.sha256 = 'a'.repeat(64);
    const changedContent = source(4);
    changedContent.report.limitations = ['Different source content.'];
    expect(find([a, changedHash, changedContent, source(5, 2)])).toEqual([
      { laboratoryId: a.report.laboratoryId, seriesId: a.report.seriesId, revision: 1, sourceIds: [sourceId(1), sourceId(3), sourceId(4)] },
    ]);
    expect(find([changedContent, a, changedHash])).toEqual(find([a, changedHash, changedContent]));
    expect(() => contracts.findSyntheticPgxRevisionConflicts({ tenantId, patientId, sources: [{ ...a, patientId: otherId }] })).toThrow('Invalid synthetic lineage snapshot.');
  });
  it('is independent of all input permutations and does not mutate caller objects', () => {
    const input = [source(), source(2, 2), source(3, 3)];
    const original = structuredClone(input);
    const expected = inspect(input);
    for (const order of [
      [0, 1, 2],
      [0, 2, 1],
      [1, 0, 2],
      [1, 2, 0],
      [2, 0, 1],
      [2, 1, 0],
    ])
      expect(inspect(order.map((i) => input[i]))).toEqual(expected);
    expect(input).toEqual(original);
  });
  it('treats object-key order as irrelevant without normalizing original text or array order', () => {
    const a = source();
    const b = source(2);
    b.report = Object.fromEntries(Object.entries(b.report).reverse()) as typeof b.report;
    expect(group([a, b]).state).toBe('candidate-for-review');
    b.report.findings[0].reportedCall!.originalText = ' *A / *A ';
    expect(group([a, b]).reasons).toContain('duplicate-revision-content');
  });
  it('retains ambiguous latest findings as source references without analytic acceptance or historical backfill', () => {
    const second = source(2, 2);
    const uncertain: SyntheticPgxPackage = JSON.parse(readFileSync(new URL('../../../data/fixtures/pgx-contracts/uncertain/package.json', import.meta.url), 'utf8'));
    second.report.findings = uncertain.report.findings;
    second.report.findings[0].id = 'syn-finding-b';
    second.report.assay = uncertain.report.assay;
    const result = inspect([source(), second]);
    expect(result.series[0]).toMatchObject({ state: 'candidate-for-review', candidate: { revision: 2, findingIds: ['syn-finding-b'] } });
    expect(result.independentReviewRequired).toBe(true);
    expect(result.actionable).toBe(false);
    expect(second.report.findings[0]).toMatchObject({ analyticalState: 'ambiguous', reportedCall: { kind: 'unresolved' }, laboratoryInterpretation: null });
  });
  it('accepts the 100-source bound and retains all exact upload references', () => {
    const result = group(Array.from({ length: 100 }, (_, i) => source(i + 1)));
    expect(result.state).toBe('candidate-for-review');
    expect(result.candidate?.sourceIds).toHaveLength(100);
    expect(result.revisions[0].sources).toHaveLength(100);
  });
  it.each([null, {}, { tenantId, patientId, sources: [], actionable: true }])('rejects a malformed or extended envelope', (input) => {
    expect(() => contracts.inspectSyntheticPgxLineage(input)).toThrow('Invalid synthetic lineage snapshot.');
  });
  it('accepts canonical non-UUID application tenants while refusing mixed scopes', () => {
    const s = { ...source(), tenantId: 'synthetic-clinic' };
    expect(contracts.inspectSyntheticPgxLineage({ tenantId: 'synthetic-clinic', patientId, sources: [s] }).series[0].state).toBe('candidate-for-review');
    expect(() => contracts.inspectSyntheticPgxLineage({ tenantId: 'another-clinic', patientId, sources: [s] })).toThrow('Invalid synthetic lineage snapshot.');
  });
  it('returns no candidate for an empty collection', () => {
    expect(inspect([]).series).toEqual([]);
  });
  it.each([
    ['duplicate source ID', () => [source(), source()]],
    ['too many snapshots', () => Array.from({ length: 101 }, (_, i) => source(i + 1))],
    ['invalid hash', () => [{ ...source(), sha256: 'not-a-hash' }]],
    ['unbounded version', () => [{ ...source(), objectVersion: 'x'.repeat(1025) }]],
    [
      'invalid laboratory report',
      () => {
        const s = source();
        s.report.findings[0].reportedCall = null;
        return [s];
      },
    ],
    ['uploaded approval flag', () => [{ ...source(), approved: true }]],
  ] as const)('refuses %s', (_label, input) => {
    expect(() => inspect(input())).toThrow('Invalid synthetic lineage snapshot.');
  });
});
