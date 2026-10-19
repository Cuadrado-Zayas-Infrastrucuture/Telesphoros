import { randomUUID } from 'node:crypto';
import { utf8Length, type Candidate, type Outcome, type ScriptedReply, type Source, type State } from '../src/contracts';
import { checkCandidate, checkVerdict, evidenceIdentity, hashBytes } from '../src/evidence';
import { durableSourceSchema, type Decision, type DurableSyntheticStore, type Expected, type RefusalCode,
  type RunView, type Stamp } from './contracts';

export interface ScriptedActors {
  draft(sources: readonly Source[], attemptId: string): Promise<ScriptedReply>;
  director(candidate: Candidate, evidenceDigest: string, attemptId: string): Promise<ScriptedReply>;
}

const refused = (code: RefusalCode): Decision<Outcome | null> => ({ kind: 'refused', code });
const expectedOf = (run: RunView): Expected => ({ state: run.state, sequence: run.sequence });

/** Fixed topology only. The store's protected SQL remains the authority for every transition and commit. */
export async function runDurableSynthetic(stamp: Stamp, initial: Expected, store: DurableSyntheticStore,
  actors: ScriptedActors, signal: AbortSignal): Promise<Decision<Outcome | null>> {
  if (signal.aborted) return refused('ABORTED');
  const loaded = await store.load(stamp, initial);
  if (loaded.kind === 'refused') return loaded;
  let run = loaded.value;
  if (run.outcomeCommitted) return { kind: 'ok', value: null }; // queue ack only; never redispatch
  if (run.dispatchUnknown || run.state !== 'queued') return refused('USAGE_UNKNOWN');
  const sourceResult = await store.sources(stamp, expectedOf(run));
  if (sourceResult.kind === 'refused') return sourceResult;
  const sources = sourceResult.value;
  if (sources.length < 1 || sources.length > 4 || new Set(sources.map(s => s.id)).size !== sources.length ||
    sources.reduce((n, s) => n + utf8Length(s.body), 0) > 16384 ||
    sources.some(s => !durableSourceSchema.safeParse(s).success || hashBytes(s.body) !== s.digest || s.tenantId === ''))
    return refused('INVALID_EVIDENCE');
  const evidenceDigest = evidenceIdentity([...sources]);
  const move = async (next: State): Promise<RefusalCode | null> => {
    const response = await store.advance(stamp, expectedOf(run), next);
    if (response.kind === 'refused') return response.code;
    run = response.value;
    return null;
  };
  const finish = async (reasonCode: string, terminalState: 'held' | 'failed' | 'released', candidate?: Candidate,
    verdict?: ReturnType<typeof checkVerdict>): Promise<Decision<Outcome | null>> => {
    const result = await store.finish(stamp, expectedOf(run), { terminalState, reasonCode,
      ...(candidate ? { candidate } : {}), ...(verdict ? { verdict } : {}),
      ...(candidate ? { evidenceDigest } : {}) });
    return result;
  };
  const moved = await move('running');
  if (moved) return refused(moved);

  for (const ordinal of [1, 2] as const) {
    if (signal.aborted) return refused('ABORTED');
    const draftAttempt = `${stamp.runId}:draft:${ordinal}`;
    const draftInvocation = { invocationId: randomUUID(), role: 'draft' as const, ordinal,
      inputDigest: hashBytes(JSON.stringify([draftAttempt, evidenceDigest, sources.map(s => [s.id, s.version, s.digest])])) };
    const begunDraft = await store.begin(stamp, expectedOf(run), draftInvocation);
    if (begunDraft.kind === 'refused') return begunDraft;
    run = begunDraft.value;
    let draft: ScriptedReply;
    try { draft = await actors.draft(sources, draftAttempt); }
    catch { return refused('USAGE_UNKNOWN'); }
    if (signal.aborted) return refused('ABORTED');
    let candidate: Candidate | null = null;
    try { candidate = checkCandidate(draft.artifact, [...sources]); }
    catch { /* The bounded observation is still recorded before a failed, nonrelease finish. */ }
    const observedDraft = await store.observe(stamp, expectedOf(run), { invocationId: draftInvocation.invocationId,
      role: 'draft', inputDigest: draftInvocation.inputDigest, observation: draft.observation,
      artifact: candidate });
    if (observedDraft.kind === 'refused') return observedDraft;
    run = observedDraft.value;
    if (!draft.observation) return refused('USAGE_UNKNOWN');
    if (!candidate) return finish('INVALID_EVIDENCE', 'failed');

    const reviewing = await move('reviewing');
    if (reviewing) return refused(reviewing);
    if (signal.aborted) return refused('ABORTED');
    const directorAttempt = `${stamp.runId}:director:${ordinal}`;
    const directorInvocation = { invocationId: randomUUID(), role: 'director' as const, ordinal,
      inputDigest: hashBytes(JSON.stringify([directorAttempt, candidate.digest, evidenceDigest])) };
    const begunDirector = await store.begin(stamp, expectedOf(run), directorInvocation);
    if (begunDirector.kind === 'refused') return begunDirector;
    run = begunDirector.value;
    let review: ScriptedReply;
    try { review = await actors.director(candidate, evidenceDigest, directorAttempt); }
    catch { return refused('USAGE_UNKNOWN'); }
    if (signal.aborted) return refused('ABORTED');
    let verdict: ReturnType<typeof checkVerdict> | null = null;
    try { verdict = checkVerdict(review.artifact, candidate, evidenceDigest); }
    catch { /* A malformed verdict is recorded as absent, never interpreted as repair. */ }
    const observedDirector = await store.observe(stamp, expectedOf(run), { invocationId: directorInvocation.invocationId,
      role: 'director', inputDigest: directorInvocation.inputDigest, observation: review.observation,
      artifact: verdict });
    if (observedDirector.kind === 'refused') return observedDirector;
    run = observedDirector.value;
    if (!review.observation) return refused('USAGE_UNKNOWN');
    if (!verdict) return finish('INVALID_EVIDENCE', 'failed');
    if (verdict.decision === 'hold') return finish('DIRECTOR_HELD', 'held');
    if (verdict.decision === 'repair') {
      if (ordinal === 2) return finish('REPAIR_EXHAUSTED', 'held');
      const repair = await move('repair-pending');
      if (repair) return refused(repair);
      const second = await move('running');
      if (second) return refused(second);
      continue;
    }
    const releasePending = await move('release-pending');
    if (releasePending) return refused(releasePending);
    return finish('SIMULATED_RELEASE', 'released', candidate, verdict);
  }
  return refused('INVALID_TRANSITION');
}
