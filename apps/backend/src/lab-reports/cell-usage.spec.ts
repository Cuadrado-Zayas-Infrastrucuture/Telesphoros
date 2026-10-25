import { cellUsageQuerySchema } from '@telesphoros/shared-types';
import type { DisputeInput, Projected } from '../storage/ledger-records';
import { cellMatches } from './cell-usage';

const cell: DisputeInput = { guidelineId: 'syn', guidelineVersion: '1', guidelineContentSha256: 'a'.repeat(64), locator: { table: 'T', row: 'R' }, note: '' };
const file = { guidelineId: 'syn', guidelineVersion: '1', contentSha256: 'a'.repeat(64) };
const result = {
  drug: 'synthetic',
  outcome: 'shown',
  recommendationText: 'Synthetic wording',
  citation: { guidelineId: 'syn', guidelineVersion: '1', locator: { table: 'T', row: 'R', column: null } },
};
const record = (binding: unknown = {}): Projected => ({ id: 'syn', tenantId: 'syn', seq: '1', createdBy: 'syn', createdAt: 'syn', binding, results: [result] });
const bound = (files = [file]) => ({ cellProvenance: { version: 'cell-provenance/1', files } });

it('requires the exact recorded file hash and preserves unverified historical candidates', () => {
  expect(cellMatches(record(bound()), cell)).toEqual([{ resultIndex: 0, drug: 'synthetic', outcome: 'shown', identity: 'exact-file', wordingExposed: true }]);
  expect(cellMatches(record(), cell)[0]?.identity).toBe('historical-identity-unverified');
  expect(cellMatches(record(bound([{ ...file, contentSha256: 'b'.repeat(64) }])), cell)).toEqual([]);
  for (const binding of [bound([]), bound([file, { ...file, contentSha256: 'b'.repeat(64) }]), { cellProvenance: { version: 'wrong', files: [file] } }]) {
    expect(cellMatches(record(binding), cell)[0]?.identity).toBe('historical-identity-unverified');
  }
});
it('matches every identity component, with null and omitted column equivalent but no other normalization', () => {
  for (const change of [
    { guidelineId: 'other' },
    { guidelineVersion: '2' },
    { locator: { table: 't', row: 'R' } },
    { locator: { table: 'T', row: 'r' } },
    { locator: { table: 'T', row: 'R', column: 'C' } },
  ]) {
    expect(cellMatches(record(bound()), { ...cell, ...change })).toEqual([]);
  }
  const r = record(bound());
  r.results = [result, { ...result, citation: null }];
  expect(cellMatches(r, cell)).toHaveLength(1);
});
it('distinguishes withheld citations from wording-bearing results and emits no source text', () => {
  const r = record(bound());
  r.results = [result, { ...result, outcome: 'held', recommendationText: undefined }, { ...result, outcome: 'no-published-recommendation' }];
  expect(cellMatches(r, cell).map((x) => x.wordingExposed)).toEqual([true, false, true]);
  expect(JSON.stringify(cellMatches(r, cell))).not.toContain('Synthetic wording');
});
it('bounds pagination without floating-point sequence conversion', () => {
  expect(cellUsageQuerySchema.parse({})).toEqual({ afterSeq: '0', limit: 50 });
  expect(cellUsageQuerySchema.parse({ afterSeq: '9223372036854775807', limit: '100' }).afterSeq).toBe('9223372036854775807');
  for (const q of [
    { afterSeq: 'invalid' },
    { afterSeq: '1.2' },
    { afterSeq: '-1' },
    { afterSeq: '01' },
    { afterSeq: '9223372036854775808' },
    { limit: '101' },
    { limit: '0' },
    { limit: '1e2' },
    { extra: 'x' },
  ])
    expect(cellUsageQuerySchema.safeParse(q).success).toBe(false);
});
