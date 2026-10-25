import { contextSchema, emptyCounters, outcomeSchema, requestSchema, type Context, type Outcome, type Ports, type Run, type State, type TerminalState } from './contracts';
import { expired } from './budgets';
import { checkCandidate, checkSources, checkVerdict, evidenceIdentity, hashBytes } from './evidence';
import { syntheticProfile, validProfile } from './policy';

export const terminal = (s: State): boolean => ['released', 'held', 'failed', 'cancelled', 'expired'].includes(s);
const transitions: Partial<Record<State, State[]>> = {
  admitted: ['queued'],
  queued: ['running'],
  running: ['reviewing'],
  reviewing: ['repair-pending', 'release-pending'],
  'repair-pending': ['running'],
};
export const canTransition = (from: State, to: State): boolean =>
  !terminal(from) && (['held', 'failed', 'cancelled', 'expired'].includes(to) || (from === 'release-pending' && to === 'released') || (transitions[from]?.includes(to) ?? false));
function current(context: Context, ports: Ports): boolean {
  const a = ports.authority.current(context);
  return (
    a.tenantId === context.tenantId &&
    a.requesterRef === context.requesterRef &&
    a.generation === context.authorityGeneration &&
    a.member &&
    a.session &&
    a.expiresAt > ports.clock.utcNowMs() &&
    a.purpose === context.purpose &&
    ['business.sop.read', 'business.sop.draft'].every((c) => a.capabilities.includes(c)) &&
    context.sources.every((s) => a.sourceIds.includes(s.id))
  );
}
function outcome(run: Run | null, reason: string, state: TerminalState = 'held', ports?: Ports): Outcome {
  return {
    schemaVersion: 'synthetic.business-outcome.v1',
    evidenceKind: 'synthetic-control-flow',
    runId: run?.id ?? 'unadmitted',
    terminalState: state,
    tenantId: run?.tenantId ?? null,
    requesterRef: run?.requesterRef ?? null,
    fixtureProfileDigest: run?.profileDigest ?? syntheticProfile().profileDigest,
    simulatedArtifact: null,
    simulationReceiptRef: null,
    reasonCode: reason,
    counters: run && ports ? ports.budgets.counters(run.id) : emptyCounters(),
  };
}
export async function runSynthetic(input: unknown, trustedContext: Context, ports: Ports, proposedProfile: unknown = syntheticProfile()): Promise<Outcome> {
  const parsed = requestSchema.safeParse(input);
  const binding = contextSchema.safeParse(trustedContext);
  if (!parsed.success || !binding.success) return outcome(null, 'INVALID_INPUT');
  if (!validProfile(proposedProfile)) return outcome(null, 'PROFILE_DISABLED');
  const profile = proposedProfile;
  const context = binding.data;
  const request = parsed.data;
  if (request.taskKey !== profile.taskKey) return outcome(null, 'OUT_OF_SYNTHETIC_SCOPE');
  let run: Run | null = null;
  const check = (name: string) => {
    ports.boundary(name);
    if (!current(context, ports)) throw new Error('AUTHORITY_HELD');
    if (run && expired(run, ports.clock.utcNowMs(), ports.clock.monotonicNowMs())) throw new Error('DEADLINE');
    if (run) {
      const now = ports.store.get(run.id);
      if (now.sequence !== run.sequence || now.fence !== run.fence || terminal(now.state)) throw new Error('STALE_FENCE');
    }
  };
  const advance = (state: State) => {
    if (!run || !canTransition(run.state, state)) throw new Error('STALE_FENCE');
    const next = ports.store.advance(run, state);
    if (!next) throw new Error('STALE_FENCE');
    run = next;
  };
  const finish = (reason: string, state: TerminalState = 'held') => {
    const o = outcome(run, reason, state, ports);
    if (run)
      ports.store.commitSimulation(
        run,
        o,
        () => true,
        () => ports.budgets.complete(run!.id),
      );
    return o;
  };
  try {
    check('admission');
    const tuple = JSON.stringify([request.schemaVersion, request.taskKey, request.locale, request.question]);
    const key = JSON.stringify([context.tenantId, context.requesterRef, request.taskKey, request.idempotencyKey]);
    const admitted = ports.store.admit(key, tuple, context, profile.profileDigest, ports.clock.utcNowMs(), ports.clock.monotonicNowMs());
    run = admitted.run;
    if (run.tenantId !== context.tenantId || run.requesterRef !== context.requesterRef || run.profileDigest !== profile.profileDigest) return outcome(null, 'STORE_BINDING');
    if (admitted.kind === 'conflict') return outcome(run, 'IDEMPOTENCY_CONFLICT');
    if (admitted.kind === 'existing') {
      if (!current(context, ports)) return outcome(run, 'AUTHORITY_HELD');
      const cached = outcomeSchema.safeParse(ports.store.outcome(run.id));
      if (!cached.success) return outcome(run, 'IN_PROGRESS');
      const c = cached.data;
      const bound =
        c.runId === run.id &&
        c.tenantId === context.tenantId &&
        c.requesterRef === context.requesterRef &&
        c.fixtureProfileDigest === profile.profileDigest &&
        c.terminalState === run.state;
      const intact = c.simulatedArtifact === null || (hashBytes(c.simulatedArtifact.text) === c.simulatedArtifact.digest && c.simulationReceiptRef === `simulation:${run.id}`);
      return bound && intact ? c : outcome(run, 'STORE_BINDING');
    }
    if (!ports.budgets.reserve(run, profile)) return finish('BUDGET_HELD');
    advance('queued');
    check('retrieve');
    advance('running');
    const sources = checkSources(ports.sources.resolve(context), context);
    const evidenceDigest = evidenceIdentity(sources);
    for (let attempt = 1; attempt <= 2; attempt++) {
      check('draft');
      const draftAttempt = `${run!.id}:draft:${attempt}`;
      if (!ports.budgets.begin(run!.id, draftAttempt)) return finish('USAGE_HELD');
      const reply = await ports.actors.draft(sources, draftAttempt);
      check('draft-complete');
      if (!ports.budgets.observe(run!.id, 'draft', draftAttempt, reply.observation)) return finish('USAGE_HELD');
      const candidate = checkCandidate(reply.artifact, sources);
      advance('reviewing');
      check('director');
      const reviewAttempt = `${run!.id}:director:${attempt}`;
      if (!ports.budgets.begin(run!.id, reviewAttempt)) return finish('USAGE_HELD');
      const review = await ports.actors.director(candidate, evidenceDigest, reviewAttempt);
      check('director-complete');
      if (!ports.budgets.observe(run!.id, 'director', reviewAttempt, review.observation)) return finish('USAGE_HELD');
      const verdict = checkVerdict(review.artifact, candidate, evidenceDigest);
      if (verdict.decision === 'hold') return finish('DIRECTOR_HELD');
      if (verdict.decision === 'repair') {
        if (attempt >= 2) return finish('REPAIR_EXHAUSTED');
        advance('repair-pending');
        advance('running');
        continue;
      }
      checkCandidate(candidate, sources);
      advance('release-pending');
      check('release');
      const result = outcome(run, 'SIMULATED_RELEASE', 'released', ports);
      result.simulatedArtifact = { text: candidate.text, digest: candidate.digest };
      result.simulationReceiptRef = `simulation:${run!.id}`;
      const committed = ports.store.commitSimulation(
        run!,
        result,
        () => current(context, ports) && !expired(run!, ports.clock.utcNowMs(), ports.clock.monotonicNowMs()),
        () => ports.budgets.complete(run!.id),
      );
      return committed ? result : outcome(run, 'COMMIT_HELD');
    }
    return finish('REPAIR_EXHAUSTED');
  } catch {
    if (run && expired(run, ports.clock.utcNowMs(), ports.clock.monotonicNowMs())) return finish('DEADLINE', 'expired');
    return finish('CONTROL_HELD');
  }
}
