import { lookupOffline } from './lookup';
import { fixture, SCOPE, stateFor, testKnowledge, testPolicy } from '../../../test/helpers/report-lookup';
import { GENES, outcomeSchema, type GeneState, type LookupReason } from './contracts';
import { artifactHash, recordHash } from './strict-json';
import { routeAdmitted, validatePolicyKnowledge } from './routing';

// Hand-written oracle, independently expressed from the implementation branches.
const KINDS: GeneState['state'][] = ['canonical', 'absent', 'approved-unavailable', 'unresolved', 'sentinel', 'empty'];
const GOLD = [
  ['combined', 'single-c19', 'single-c19', 'held', 'held', 'held'],
  ['single-b6', 'no-row', 'no-row', 'held', 'held', 'held'],
  ['single-b6', 'no-row', 'no-row', 'held', 'held', 'held'],
  ['held', 'held', 'held', 'held', 'held', 'held'],
  ['held', 'held', 'held', 'held', 'held', 'held'],
  ['held', 'held', 'held', 'held', 'held', 'held'],
];
const run = (f: ReturnType<typeof fixture>, scope = SCOPE, raw = JSON.stringify(f.input)) => lookupOffline(raw, scope, f.ports, f.knowledge);
function expectFailure(result: Awaited<ReturnType<typeof run>>, code: LookupReason) {
  expect(result.outcome).toMatchObject({ schema: 'report-lookup-admission-failure/1', reasonCode: code, selectedRow: null });
  expect(JSON.stringify(result)).not.toContain('FICTIONAL TEST WORDING');
}

describe('six by six frozen routing oracle and real pinned reader integration', () => {
  for (const [i, left] of KINDS.entries()) for (const [j, right] of KINDS.entries()) {
    test(`${left} / ${right}`, async () => {
      const knowledge = testKnowledge(), policy = testPolicy(knowledge);
      const decision = routeAdmitted([stateFor(GENES[0], left), stateFor(GENES[1], right)], policy, knowledge);
      const expected = GOLD[i]![j]!;
      if (expected === 'held' || expected === 'no-row') expect(decision.state).toBe(expected);
      else expect(decision).toEqual({ state: 'row-selected', selectedRow: {
        guidelineId: `test-${expected}`, table: expected === 'combined' ? 'Test combined' : 'Test single',
        row: 'Test row', column: expected === 'combined' ? 'Test column' : null,
      } });
      const f = fixture([left, right]);
      const result = await run(f);
      expect(outcomeSchema.safeParse(result.outcome).success).toBe(true);
      if (left === 'absent' && right === 'absent') {
        // The current pinned reader cannot represent a ready zero-frame source; preserve that stronger hold.
        expectFailure(result, 'reader-held');
      } else if (expected === 'held') expect(result.outcome.schema).toBe('report-lookup-admission-failure/1');
      else {
        expect(result.outcome).toMatchObject({ schema: 'report-lookup-decision/1', decision });
        expect(result.snapshotVersion).toBe('test-snapshot-1');
        expect(JSON.stringify(result)).not.toContain('recommendationText');
      }
    });
  }
});

describe('ordered admission and trusted dependencies', () => {
  test.each(['tenantId', 'reportId', 'captureId'] as const)('capture is bound to %s', async (key) => {
    const f = fixture(); f.snapshot.capture[key] = 'different-scope';
    expectFailure(await run(f), 'capture-not-accepted');
  });
  test('latest rejection cannot be bypassed with an older accepted ID', async () => {
    const f = fixture(); f.snapshot.capture.acceptance = { ...f.snapshot.capture.acceptance, id: 'later-rejection', sequence: 2, decision: 'rejected' };
    expectFailure(await run(f), 'capture-not-accepted');
  });
  test('a capture author cannot self-review the capture', async () => {
    const f = fixture(); f.snapshot.capture.acceptance.reviewerId = f.snapshot.capture.createdBy;
    expectFailure(await run(f), 'capture-not-accepted');
  });
  test('source bytes/hash and pinned provenance are required', async () => {
    const f = fixture(); f.snapshot.capture.text += 'x';
    expectFailure(await run(f), 'capture-hash-mismatch');
    const g = fixture(); g.snapshot.capture.popplerVersion = '99.0'; g.snapshot.capture.acceptance.popplerVersion = '99.0';
    expectFailure(await run(g), 'poppler-version-mismatch');
  });
  test.each(['pdfSha256', 'objectVersion', 'textSha256'] as const)('acceptance binds the stored %s', async (key) => {
    const f = fixture();
    f.snapshot.capture.acceptance[key] = key === 'objectVersion' ? 'other-version' : artifactHash('other');
    expectFailure(await run(f), 'capture-hash-mismatch');
  });
  test.each(['tenantId', 'reportId', 'captureId'] as const)('source record is bound to %s', async (key) => {
    const f = fixture(); const record = f.snapshot.records[0]!.payload;
    if ('tenantId' in record) record[key] = 'different';
    f.rehash(); expectFailure(await run(f), 'lookup-input-invalid');
  });
  test.each(['tenantId', 'reportId', 'captureId'] as const)('external context targets the scoped %s', async (key) => {
    const f = fixture(); const record = f.snapshot.records.find((r) => r.payload.type === 'context-review')!.payload;
    if ('tenantId' in record) record[key] = 'different';
    f.rehash(); expectFailure(await run(f), 'lookup-context-invalid');
  });
  test('record hash tampering and superseded/rejected reviews fail', async () => {
    for (const change of ['hash', 'superseded', 'rejected']) {
      const f = fixture();
      if (change === 'hash') f.snapshot.records[0]!.recordSha256 = artifactHash('tampered');
      if (change === 'superseded') f.snapshot.latestReviews[0]!.reviewId = 'newer-review';
      if (change === 'rejected') { f.snapshot.records[0]!.payload.review.decision = 'rejected'; f.rehash(); }
      expectFailure(await run(f), 'lookup-input-invalid');
    }
  });
  test('a missing or arbitrary review ID is not acceptance', async () => {
    const f = fixture(); f.input.context.reviewRecordId = 'forged-id';
    expectFailure(await run(f), 'lookup-context-invalid');
    const g = fixture(); g.snapshot.latestReviews = [];
    expectFailure(await run(g), 'lookup-input-invalid');
  });
  test('snapshot changed by concurrent rejection is refused before return', async () => {
    const f = fixture(); f.ports.currentVersion = async () => 'test-snapshot-2-rejected';
    expectFailure(await run(f), 'snapshot-changed');
  });
  test('rehashed packet structures must equal independent source replay', async () => {
    const f = fixture();
    const reader = f.snapshot.reader as { packet: Record<string, unknown>; projection: { provenance: { packetHash: string } } };
    reader.packet.reportRegions = [{ start: 1, end: f.snapshot.capture.text.length }];
    const { packetHash: _old, ...rest } = reader.packet; void _old;
    reader.packet.packetHash = recordHash(rest);
    reader.projection.provenance.packetHash = reader.packet.packetHash as string;
    f.input.packetHash = reader.packet.packetHash as string;
    for (const wrapper of f.snapshot.records) if ('packetHash' in wrapper.payload) wrapper.payload.packetHash = f.input.packetHash;
    f.rehash();
    expectFailure(await run(f), 'packet-invalid');
  });
  test('coverage cannot erase a real source gene or change the registered region', async () => {
    const f = fixture(['canonical', 'absent']);
    const coverage = f.snapshot.records.find((r) => r.payload.type === 'coverage')!.payload;
    if (coverage.type === 'coverage') coverage.region.start += 1;
    f.rehash(); expectFailure(await run(f), 'lookup-input-invalid');
  });
  test('missing ports do not imply acceptance', async () => {
    const f = fixture();
    const result = await lookupOffline(JSON.stringify(f.input), SCOPE, {} as typeof f.ports, f.knowledge);
    expectFailure(result, 'capture-not-accepted');
  });
  test('exceptions are privacy-safe and operation deadlines cancel', async () => {
    const f = fixture(); f.ports.readSnapshot = async () => { throw new Error('SENSITIVE SOURCE'); };
    const result = await run(f); expectFailure(result, 'evidence-operation-failed');
    expect(JSON.stringify(result)).not.toContain('SENSITIVE SOURCE');
    jest.useFakeTimers();
    try {
      let aborted = false;
      const resultPromise = lookupOffline(JSON.stringify(f.input), SCOPE, {
        readSnapshot: (_scope, signal) => new Promise((_, reject) => signal.addEventListener('abort', () => { aborted = true; reject(new Error('cancelled')); })),
        currentVersion: async () => 'unreachable',
        replaySource: f.ports.replaySource,
      }, f.knowledge);
      await jest.advanceTimersByTimeAsync(2001);
      expectFailure(await resultPromise, 'evidence-operation-failed'); expect(aborted).toBe(true);
    } finally { jest.useRealTimers(); }
  });
});

describe('stronger source gates and no unavailable bypass', () => {
  test.each(['*1/*Z', '*1/*1'])('unavailable beside %s stays unresolved', async (dip) => {
    const f = fixture(['approved-unavailable', 'canonical'], `CYP2C19: diplotype ${dip}; result not available\nCYP2B6: diplotype *1/*1; result Normal Metabolizer\n`);
    expectFailure(await run(f), dip.includes('Z') ? 'allele-not-in-definitions' : 'other-gene-unresolved');
  });
  test('diplotype-only cannot provide a canonical result', async () => {
    const f = fixture(['canonical', 'canonical'], 'CYP2C19: diplotype *1/*1\nCYP2B6: diplotype *1/*1; result Normal Metabolizer\n');
    expectFailure(await run(f), 'other-gene-unresolved');
  });
  test('empty role wins over a missing context and remains distinct from unavailable', async () => {
    const f = fixture(['empty', 'canonical']);
    const raw = { ...f.input } as Record<string, unknown>; delete raw.context;
    expectFailure(await run(f, SCOPE, JSON.stringify(raw)), 'reported-field-empty');
  });
  test('empty diplotype beside a canonical result cannot be admitted', async () => {
    const f = fixture(['canonical', 'canonical'], 'CYP2C19: diplotype; result Normal Metabolizer\nCYP2B6: diplotype *1/*1; result Normal Metabolizer\n');
    expectFailure(await run(f), 'reported-field-empty');
  });
  test('reported Indeterminate is preserved as a canonical term without inventing a source row', async () => {
    const f = fixture(['canonical', 'canonical'], 'CYP2C19: result Indeterminate\nCYP2B6: diplotype *1/*1; result Normal Metabolizer\n');
    const state = f.input.geneStates[0]!;
    if (state.state === 'canonical') state.phenotype = 'Indeterminate';
    const record = f.snapshot.records[0]!.payload;
    if (record.type === 'derivation') record.phenotype = 'Indeterminate';
    f.rehash();
    expect((await run(f)).outcome).toMatchObject({ schema: 'report-lookup-decision/1',
      decision: { state: 'held', reasonCode: 'out-of-review-scope', selectedRow: null } });
  });
  test.each(['identical', 'conflict'])('duplicate %s wins and preserves empty diagnostics', async (kind) => {
    const f = fixture(['canonical', 'empty'], `CYP2C19: diplotype *1/*1; result Normal Metabolizer\nCYP2C19: diplotype *1/*1; result ${kind === 'identical' ? 'Normal' : 'Poor'} Metabolizer\nCYP2B6: result\n`);
    const result = await run(f);
    expectFailure(result, kind === 'identical' ? 'duplicate-identical' : 'duplicate-gene-conflict');
    expect(result.diagnostics).toContainEqual({ stage: 'field', reasonCode: 'reported-field-empty' });
  });
  test('registered source ambiguity is abstention, not an operational hold or an empty successful lookup', async () => {
    const f = fixture(['canonical', 'canonical'], 'Genes: CYP2C19 CYP2B6\nResults: Poor Metabolizer Normal Metabolizer\nNo ordering or field-association key supplied.\n');
    expect((await run(f)).outcome).toMatchObject({ schema: 'report-lookup-abstention/1', reasonCode: 'association-abstained', selectedRow: null });
  });
  test('quotes remain literal and cannot enter the unavailable state', async () => {
    const f = fixture(['unresolved', 'canonical']);
    expectFailure(await run(f), 'other-gene-unresolved');
  });
  test('erasing the unavailable basis is refused', async () => {
    const f = fixture(['approved-unavailable', 'canonical']);
    delete (f.input.geneStates[0] as unknown as Record<string, unknown>).basis;
    expectFailure(await run(f), 'lookup-input-invalid');
  });
});

describe('context, policy, strict records and partial bindings', () => {
  test('missing context has no invented hash', async () => {
    const f = fixture(); const raw = { ...f.input } as Record<string, unknown>; delete raw.context;
    const result = await run(f, SCOPE, JSON.stringify(raw)); expectFailure(result, 'lookup-context-required');
    if ('bindings' in result.outcome) expect(result.outcome.bindings).toMatchObject({ inputRecordSha256: null, contextRecordSha256: null, policySha256: null });
  });
  test('early capture failure has null bindings', async () => {
    const f = fixture(); f.snapshot.capture.acceptance.decision = 'rejected';
    const result = await run(f); expectFailure(result, 'capture-not-accepted');
    if ('bindings' in result.outcome) expect(Object.values(result.outcome.bindings)).toEqual([null, null, null, null, null, null]);
  });
  test('context changed source or stale knowledge is refused', async () => {
    const f = fixture(); f.input.context.drugEvidence.literalSha256 = artifactHash('wrong'); f.rehash();
    expectFailure(await run(f), 'lookup-context-source-mismatch');
    const g = fixture(); g.snapshot.knowledgeSetId = artifactHash('stale');
    expectFailure(await run(g), 'lookup-policy-invalid');
  });
  test('policy byte newline invalidates review even though meaning is unchanged', async () => {
    const f = fixture(); f.snapshot.policyBytes += '\n';
    expectFailure(await run(f), 'lookup-policy-invalid');
  });
  test('unknown input fields and old null state are refused', async () => {
    const f = fixture();
    expectFailure(await run(f, SCOPE, JSON.stringify({ ...f.input, extra: true })), 'lookup-input-invalid');
    const raw = structuredClone(f.input) as unknown as { geneStates: unknown[] }; raw.geneStates[0] = { gene: GENES[0], state: 'null' };
    expectFailure(await run(f, SCOPE, JSON.stringify(raw)), 'lookup-input-invalid');
  });
  test('source, serialized input and record-count caps fail closed', async () => {
    const f = fixture(); f.snapshot.capture.text = 'x'.repeat(100001);
    expectFailure(await run(f), 'evidence-operation-failed');
    expectFailure(await run(f, SCOPE, ' '.repeat(1048577)), 'lookup-input-invalid');
    const g = fixture(); g.snapshot.records = Array.from({ length: 201 }, () => g.snapshot.records[0]!);
    expectFailure(await run(g), 'lookup-input-invalid');
  });
  test('policy disputes/unverified cells expose no wording; ambiguous or cross-drug routes fail', async () => {
    const f = fixture(); f.snapshot.disputedRows = [f.policy.reviewedRows[0]!];
    expectFailure(await run(f), 'cell-disputed');
    const knowledge = testKnowledge(), policy = testPolicy(knowledge);
    const guideline = knowledge.guidelinesForDrug('sertraline').find((g) => g.id === policy.combinedGuidelineId)!;
    guideline.recommendations[0]!.verification = { state: 'unverified' };
    guideline.review = { status: 'reviewed', reviewedBy: 'TEST', reviewedAt: '2026-10-08', contentSha256: 'invalid' };
    expect(validatePolicyKnowledge(policy, knowledge, [])).toMatchObject({ ok: false });
    const g = fixture(); g.policy.singleGeneGuidelineIds.CYP2C19 = g.policy.combinedGuidelineId;
    expect(validatePolicyKnowledge(g.policy, g.knowledge, [])).toMatchObject({ ok: false });
  });
  test('excluded combined cell never falls back; published No recommendation is a selected row', async () => {
    const f = fixture(); const policy = structuredClone(f.policy);
    policy.reviewedRows = policy.reviewedRows.filter((r) => r.guidelineId !== policy.combinedGuidelineId);
    expect(routeAdmitted(f.input.geneStates, policy, f.knowledge)).toEqual({ state: 'held', reasonCode: 'out-of-review-scope', selectedRow: null });
    expect(routeAdmitted(f.input.geneStates, f.policy, f.knowledge).state).toBe('row-selected');
  });
  test('logical key ordering is a harmless control', async () => {
    const f = fixture(); const entries = Object.entries(f.input).reverse();
    const result = await run(f, SCOPE, JSON.stringify(Object.fromEntries(entries)));
    expect(result.outcome).toMatchObject({ schema: 'report-lookup-decision/1', inputRecordSha256: recordHash(f.input) });
  });
});
