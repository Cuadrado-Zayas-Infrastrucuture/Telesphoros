import { z } from 'zod';
import { expired } from './budgets';
import type { Run, State } from './contracts';
import { checkVerifierReply } from './evaluators/verifier';
import { runSensors } from './evaluators/sensors';
import { explainableResultSchema, explanationSchema, SENSORS } from './evaluators/types';
import { hashBytes } from './evidence';
import { EXPLAIN_CAPABILITY, EXPLAIN_LIMITS, EXPLAIN_TASK, EXPLANATION_LABEL, engineTextOf, explainContextSchema, explainRequestSchema, type ExplainContext, type ExplainOutcome, type ExplainPorts, type FailureReason } from './explain-contracts';
import { eligibility, FALLBACK_TEXT } from './fallback';
import { terminal } from './kernel';
import { buildPrompt, buildRepairPrompt } from './prompts/explain-v1';
import { buildVerifierPrompt } from './prompts/verify-v1';
import { taskProblems, TASKS, type TaskDeclaration } from './tasks';

const refusalSchema = z.strictObject({ refused: z.literal(true) });
const FIXED_CAUSES = new Set(['STALE_FENCE', 'COMMIT_HELD', 'STORE_BINDING']);

function authorityCurrent(context: ExplainContext, ports: ExplainPorts): boolean {
  const a = ports.authority.current(context);
  return a.tenantId === context.tenantId && a.requesterRef === context.requesterRef && a.generation === context.authorityGeneration && a.member && a.session
    && a.expiresAt > ports.clock.utcNowMs() && a.purpose === context.purpose && a.capabilities.includes(EXPLAIN_CAPABILITY);
}

/**
 * Explains one engine result, or returns the engine's own text and says why not. A sibling of `runSynthetic`: the same fenced states, idempotency
 * key, authority re-check at every boundary, deadline and slot/token caps, but its own context and ports (the synthetic ones are fixed to the SOP task).
 * The model is reached only through `ports.model`. Every failure, at any step, returns the engine text alone with a fixed reason code and no model word.
 */
export async function runExplanation(input: unknown, trustedContext: unknown, ports: ExplainPorts, registry: Readonly<Record<string, Partial<TaskDeclaration>>> = TASKS): Promise<ExplainOutcome> {
  let run: Run | null = null, engineText = FALLBACK_TEXT['unknown-outcome'], modelCalls = 0;
  const guards: string[] = [];
  const outcome = (reasonCode: FailureReason, detail: string | null): ExplainOutcome => ({
    released: false, reasonCode, detail, runId: run?.id ?? null, engineText, guardsRun: [...guards],
    counters: { ...(run ? ports.budgets.counters(run.id) : { slots: 0, tokens: 0 }), modelCalls },
  });
  /** End the run held, failed or expired. Never throws: a store that cannot settle still lets the engine text through. */
  const fail = (reason: FailureReason, detail: string | null = null, state: 'held' | 'failed' | 'expired' = 'held'): ExplainOutcome => {
    try { if (run && !terminal(run.state)) { const next = ports.store.advance(run, state); if (next) run = next; ports.budgets.complete(run.id); } } catch { /* the outcome below is still the engine text */ }
    return outcome(reason, detail);
  };

  const parsed = explainRequestSchema.safeParse(input), ctx = explainContextSchema.safeParse(trustedContext);
  if (!parsed.success || !ctx.success) return outcome('INVALID_INPUT', null);
  const request = parsed.data, context = ctx.data, engine = request.engine;
  const eligible = eligibility(engine.outcome, engine.reasonCode, engine.strength);
  const explainable = explainableResultSchema.safeParse(engine.explainable);
  engineText = !eligible.eligible ? eligible.text : explainable.success ? engineTextOf(explainable.data) : FALLBACK_TEXT['unknown-outcome'];

  const task = registry[EXPLAIN_TASK], problems = taskProblems(registry);
  if (task === undefined || problems.length > 0) return outcome('TASK_UNDECLARED', problems.join(';') || 'missing');
  if (task.dataClass === 'phi' && request.dataMarker === 'real') {
    if (ports.provider.syntheticOnly) return outcome('NOT_SYNTHETIC', null);
    if (!ports.provider.baaCovered) return outcome('NO_BAA', null);
  }

  const check = (name: string) => {
    ports.boundary(name);
    if (!authorityCurrent(context, ports)) throw new Error('AUTHORITY_HELD');
    if (run && expired(run, ports.clock.utcNowMs(), ports.clock.monotonicNowMs())) throw new Error('DEADLINE');
    if (run) { const now = ports.store.get(run.id); if (now.sequence !== run.sequence || now.fence !== run.fence || terminal(now.state)) throw new Error('STALE_FENCE'); }
  };
  const advance = (state: State) => { const next = run ? ports.store.advance(run, state) : null; if (!next) throw new Error('STALE_FENCE'); run = next; };
  const call = async (prompt: { prompt: string; templateDigest: string }, maxOutputUnits: number) => { modelCalls++; return ports.model.complete({ prompt: prompt.prompt, templateDigest: prompt.templateDigest, maxOutputUnits }); };

  try {
    check('admission');
    const tuple = hashBytes(JSON.stringify([request.dataMarker, engine.outcome, engine.reasonCode, engine.strength, engine.explainable]));
    const key = JSON.stringify([context.tenantId, context.requesterRef, EXPLAIN_TASK, request.idempotencyKey]);
    const admitted = ports.store.admit(key, tuple, context, ports.harnessVersion, ports.clock.utcNowMs(), ports.clock.monotonicNowMs());
    if (admitted.run.tenantId !== context.tenantId || admitted.run.requesterRef !== context.requesterRef) return outcome('CONTROL_HELD', 'STORE_BINDING');
    // An existing run is another request's: report on it, never settle it. The harness stores no explanation text (FR-014), so a replay returns the engine text only.
    if (admitted.kind === 'conflict') return outcome('IDEMPOTENCY_CONFLICT', null);
    if (admitted.kind === 'existing') return outcome(terminal(admitted.run.state) ? 'IDEMPOTENT_REPLAY' : 'IN_PROGRESS', null);
    run = admitted.run;
    if (!ports.budgets.reserve(run)) return fail('BUDGET_HELD');
    advance('queued'); check('retrieve'); advance('running');
    if (!eligible.eligible) return fail('NOT_ELIGIBLE', eligible.reason);
    if (!explainable.success) return fail('INPUT_REFUSED');
    const result = explainable.data;

    let reasons: string[] = [];
    for (let attempt = 1; attempt <= EXPLAIN_LIMITS.draftAttempts; attempt++) {
      check('draft');
      let drafting;
      try { drafting = attempt === 1 ? buildPrompt(result) : buildRepairPrompt(result, reasons); } catch { return fail('INPUT_REFUSED'); }
      const draftAttempt = `${run!.id}:draft:${attempt}`;
      if (!ports.budgets.begin(run!.id, draftAttempt)) return fail('USAGE_HELD');
      let reply;
      try { reply = await call(drafting, 768); } catch { return fail('MODEL_ERROR'); }
      check('draft-complete');
      if (!ports.budgets.observe(run!.id, 'draft', draftAttempt, reply.observation)) return fail('USAGE_HELD');
      if (refusalSchema.safeParse(reply.artifact).success) return fail('MODEL_REFUSED');
      advance('reviewing');

      const explanation = explanationSchema.safeParse(reply.artifact);
      if (explanation.success && guards.length === 0) guards.push(...SENSORS);
      reasons = explanation.success ? [...new Set(runSensors(explanation.data, result).map(h => h.reason))] : ['INVALID_STRUCTURE'];
      if (reasons.length > 0) {
        if (attempt >= EXPLAIN_LIMITS.draftAttempts) return fail(explanation.success ? 'SENSOR_HOLD' : 'INVALID_STRUCTURE', reasons.join(','));
        advance('repair-pending'); advance('running'); continue;
      }
      if (!explanation.success) return fail('CONTROL_HELD');

      // The verifier is called only for an explanation every sensor passed, and it can only add a hold.
      check('verify');
      const verifying = buildVerifierPrompt(result, explanation.data);
      const verifyAttempt = `${run!.id}:verify:${attempt}`;
      if (!ports.budgets.begin(run!.id, verifyAttempt)) return fail('USAGE_HELD');
      let judged;
      try { judged = await call(verifying, 1024); } catch { return fail('MODEL_ERROR'); }
      check('verify-complete');
      if (!ports.budgets.observe(run!.id, 'verify', verifyAttempt, judged.observation)) return fail('USAGE_HELD');
      guards.push('VERIFIER');
      const verdict = checkVerifierReply(judged.artifact, explanation.data);
      if (!verdict.ok) return fail('VERIFIER_HOLD', verdict.reason);

      advance('release-pending'); check('release');
      advance('released'); ports.budgets.complete(run!.id);
      return { released: true, reasonCode: 'RELEASED', label: EXPLANATION_LABEL, explanation: explanation.data, runId: run!.id, engineText, guardsRun: [...guards], counters: { ...ports.budgets.counters(run!.id), modelCalls } };
    }
    return fail('SENSOR_HOLD', reasons.join(','));
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    if (run && expired(run, ports.clock.utcNowMs(), ports.clock.monotonicNowMs())) return fail('DEADLINE', null, 'expired');
    if (message === 'AUTHORITY_HELD') return fail('AUTHORITY_HELD');
    return fail('CONTROL_HELD', FIXED_CAUSES.has(message) ? message : null);
  }
}
