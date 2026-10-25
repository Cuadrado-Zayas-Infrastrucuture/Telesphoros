import { emptyCounters, type Outcome, type State } from '../../src/contracts';
import { canTransition } from '../../src/kernel';
import { scenario } from './memory-adapters';
import type { Decision, DurableSyntheticStore, Expected, Invocation, RefusalCode, RunView, ScriptedObservation, Stamp, TerminalProposal } from '../../durable/contracts';

const runId = '22222222-2222-4222-8222-222222222222';
const jobId = '11111111-1111-4111-8111-111111111111';
const stamp: Stamp = { jobId, runId, workerId: 'worker-a', queueAttempt: 1, claimId: '33333333-3333-4333-8333-333333333333', fence: '1' };
const initial: Expected = { state: 'queued', sequence: '1' };

export function durableScenario() {
  const fixture = scenario();
  const trace: string[] = [];
  let run: RunView = {
    schemaVersion: 'synthetic.durable.v1',
    runId,
    state: 'queued',
    sequence: '1',
    deadlineAt: '2026-10-18T23:00:00Z',
    selectedAttempt: null,
    outcomeCommitted: false,
    dispatchUnknown: false,
  };
  let deny: { stage: string; code: RefusalCode } | null = null;
  let repaired = false;
  const counts = { draft: 0, director: 0 };
  const ok = (): Decision<RunView> => ({ kind: 'ok', value: run });
  const check = (expected: Expected, stage: string): RefusalCode | null => {
    trace.push(stage);
    if (deny?.stage === stage) return deny.code;
    return expected.state === run.state && expected.sequence === run.sequence ? null : 'STALE_SEQUENCE';
  };
  const tick = (state: State = run.state) => {
    run = { ...run, state, sequence: String(BigInt(run.sequence) + 1n) };
  };
  const store: DurableSyntheticStore = {
    async admit() {
      throw new Error('unused');
    },
    async read() {
      throw new Error('unused');
    },
    async cancel() {
      throw new Error('unused');
    },
    async load(_stamp, expected) {
      const failure = check(expected, 'load');
      return failure ? { kind: 'refused', code: failure } : ok();
    },
    async sources(_stamp, expected) {
      const failure = check(expected, 'sources');
      return failure ? { kind: 'refused', code: failure } : { kind: 'ok', value: [fixture.source] };
    },
    async advance(_stamp, expected, next) {
      const failure = check(expected, `advance:${next}`);
      if (failure) return { kind: 'refused', code: failure };
      if (!canTransition(run.state, next) || (next === 'repair-pending' && !repaired)) return { kind: 'refused', code: 'INVALID_TRANSITION' };
      tick(next);
      return ok();
    },
    async begin(_stamp, expected, invocation: Invocation) {
      const stage = `begin:${invocation.role}:${invocation.ordinal}`;
      const failure = check(expected, stage);
      if (failure) return { kind: 'refused', code: failure };
      if (invocation.role === 'draft' && invocation.ordinal === 2 && !repaired) return { kind: 'refused', code: 'INVALID_TRANSITION' };
      tick();
      return ok();
    },
    async observe(_stamp, expected, receipt: ScriptedObservation) {
      const failure = check(expected, `observe:${receipt.role}`);
      if (failure) return { kind: 'refused', code: failure };
      if (receipt.role === 'director' && receipt.artifact && 'decision' in receipt.artifact && receipt.artifact.decision === 'repair') repaired = true;
      tick();
      return ok();
    },
    async finish(_stamp, expected, proposal: TerminalProposal): Promise<Decision<Outcome>> {
      const failure = check(expected, `finish:${proposal.terminalState}`);
      if (failure) return { kind: 'refused', code: failure };
      tick(proposal.terminalState);
      const outcome: Outcome = {
        schemaVersion: 'synthetic.business-outcome.v1',
        evidenceKind: 'synthetic-control-flow',
        runId,
        tenantId: fixture.context.tenantId,
        requesterRef: fixture.context.requesterRef,
        fixtureProfileDigest: 'sha256:' + 'a'.repeat(64),
        terminalState: proposal.terminalState,
        simulatedArtifact: proposal.candidate ? { text: proposal.candidate.text, digest: proposal.candidate.digest } : null,
        simulationReceiptRef: proposal.candidate ? `simulation:${runId}` : null,
        reasonCode: proposal.reasonCode,
        counters: emptyCounters(),
      };
      return { kind: 'ok', value: outcome };
    },
  };
  const actors = {
    draft: async () => {
      trace.push('actor:draft');
      counts.draft++;
      return { artifact: structuredClone(fixture.candidate), observation: { inputUnits: 100, generatedUnits: 50 } };
    },
    director: async (candidate: typeof fixture.candidate, evidenceDigest: string) => {
      trace.push('actor:director');
      counts.director++;
      return {
        artifact: { decision: 'accept', candidateDigest: candidate.digest, evidenceDigest, claimVerdicts: [{ claimId: 'claim-1', supported: true }] },
        observation: { inputUnits: 100, generatedUnits: 50 },
      };
    },
  };
  return {
    stamp,
    initial,
    store,
    actors,
    trace,
    counts,
    denyAt(stage: string, code: RefusalCode) {
      deny = { stage, code };
    },
    setUnknown() {
      run = { ...run, dispatchUnknown: true };
    },
  };
}
