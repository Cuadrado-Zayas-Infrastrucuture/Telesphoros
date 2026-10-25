import { z } from 'zod';
import { expired } from './budgets';
import type { Observation, Run, State } from './contracts';
import { checkVerifierReply } from './evaluators/verifier';
import { runSensors } from './evaluators/sensors';
import { explainableResultSchema, explanationSchema, SENSORS } from './evaluators/types';
import {
  EXPLAIN_CAPABILITY,
  EXPLAIN_LIMITS,
  EXPLAIN_TASK,
  EXPLANATION_LABEL,
  engineTextOf,
  explainContextSchema,
  explainRequestSchema,
  type ExplainContext,
  type ExplainOutcome,
  type ExplainPorts,
  type FailureReason,
} from './explain-contracts';
import { eligibility, FALLBACK_TEXT } from './fallback';
import { terminal } from './kernel';
import { buildPrompt, buildRepairPrompt } from './prompts/explain-v1';
import { canonicalJson, keyedDigest } from './keyed-digest';
import { buildReceipt } from './receipt';
import type { TraceStep } from './trace';
import { buildVerifierPrompt } from './prompts/verify-v1';
import { taskProblems, TASKS, type TaskDeclaration } from './tasks';

const refusalSchema = z.strictObject({ refused: z.literal(true) });
const FIXED_CAUSES = new Set(['STALE_FENCE', 'COMMIT_HELD', 'STORE_BINDING']);

function authorityCurrent(context: ExplainContext, ports: ExplainPorts): boolean {
  const a = ports.authority.current(context);
  return (
    a.tenantId === context.tenantId &&
    a.requesterRef === context.requesterRef &&
    a.generation === context.authorityGeneration &&
    a.member &&
    a.session &&
    a.expiresAt > ports.clock.utcNowMs() &&
    a.purpose === context.purpose &&
    a.capabilities.includes(EXPLAIN_CAPABILITY)
  );
}

/**
 * Explains one engine result, or returns the engine's own text and says why not. A sibling of `runSynthetic`: the same fenced states, idempotency
 * key, authority re-check at every boundary, deadline and slot/token caps, but its own context and ports (the synthetic ones are fixed to the SOP task).
 * The model is reached only through `ports.model`. Every failure, at any step, returns the engine text alone with a fixed reason code and no model word.
 */
export async function runExplanation(
  input: unknown,
  trustedContext: unknown,
  ports: ExplainPorts,
  registry: Readonly<Record<string, Partial<TaskDeclaration>>> = TASKS,
): Promise<ExplainOutcome> {
  let run: Run | null = null,
    engineText = FALLBACK_TEXT['unknown-outcome'],
    modelCalls = 0,
    templateDigest: string | null = null,
    evidence: unknown = input,
    context: ExplainContext | null = null;
  const artifact: { present: boolean; value?: unknown } = { present: false };
  const guards: string[] = [];
  const trace: TraceStep[] = [];
  const usage = { input: 0, generated: 0, pending: 0 };
  const started = ports.clock.monotonicNowMs();
  let lastMark = started;
  /** Record a step: its name, the run state, a fixed code if it held, how long it took and the usage so far. */
  const mark = (step: TraceStep['step'], reasonCode: string | null = null) => {
    const now = ports.clock.monotonicNowMs();
    trace.push({ step, state: run?.state ?? 'held', reasonCode, durationMs: Math.max(0, now - lastMark), inputUnits: usage.input, generatedUnits: usage.generated });
    lastMark = now;
  };
  /** Usage is known only when every call that began has reported; a call that began and did not report leaves it unknown, never zero. */
  const counters = async () => {
    let base = { slots: 0, tokens: 0 };
    if (run) {
      try {
        base = await ports.budgets.counters(run.id);
      } catch {
        /* the store is unreachable: the slot and token figures stay zero, the usage this process saw is still reported */
      }
    }
    return { ...base, modelCalls, inputUnits: usage.input, generatedUnits: usage.generated, usageState: (usage.pending > 0 ? 'unknown' : 'known') as 'known' | 'unknown' };
  };
  /** Close the trace and build the durable record. Called once, on the way out of every path. */
  const seal = async (reasonCode: string, detail: string | null, released: boolean) => {
    mark('end', reasonCode);
    const c = await counters();
    const receipt = context
      ? buildReceipt({
          context,
          runId: run?.id ?? null,
          released,
          reasonCode,
          detail,
          harnessVersion: ports.harnessVersion,
          model: ports.model.identity,
          templateDigest,
          evidence,
          artifact,
          guardsRun: guards,
          counters: { slots: c.slots, modelCalls: c.modelCalls, inputUnits: c.inputUnits, generatedUnits: c.generatedUnits, usageState: c.usageState },
          key: ports.digestKey,
        })
      : null;
    return { runId: run?.id ?? null, engineText, guardsRun: [...guards], counters: c, trace: [...trace], receipt };
  };
  const outcome = async (reasonCode: FailureReason, detail: string | null): Promise<ExplainOutcome> => ({
    released: false,
    reasonCode,
    detail,
    ...(await seal(reasonCode, detail, false)),
  });
  /** End the run held, failed or expired. Never throws: a store that cannot settle still lets the engine text through. */
  const fail = async (reason: FailureReason, detail: string | null = null, state: 'held' | 'failed' | 'expired' = 'held'): Promise<ExplainOutcome> => {
    try {
      if (run && !terminal(run.state)) {
        const next = await ports.store.advance(run, state);
        if (next) run = next;
        await ports.budgets.complete(run.id);
      }
    } catch {
      /* the outcome below is still the engine text */
    }
    return outcome(reason, detail);
  };

  const parsed = explainRequestSchema.safeParse(input),
    ctx = explainContextSchema.safeParse(trustedContext);
  if (ctx.success) context = ctx.data;
  if (!parsed.success || !ctx.success) return outcome('INVALID_INPUT', null);
  const request = parsed.data,
    engine = request.engine;
  const trusted = ctx.data;
  evidence = engine.explainable;
  const eligible = eligibility(engine.outcome, engine.reasonCode, engine.strength);
  const explainable = explainableResultSchema.safeParse(engine.explainable);
  engineText = !eligible.eligible ? eligible.text : explainable.success ? engineTextOf(explainable.data) : FALLBACK_TEXT['unknown-outcome'];

  const task = registry[EXPLAIN_TASK],
    problems = taskProblems(registry);
  if (task === undefined || problems.length > 0) return outcome('TASK_UNDECLARED', problems.join(';') || 'missing');
  if (task.dataClass === 'phi' && request.dataMarker === 'real') {
    if (ports.provider.syntheticOnly) return outcome('NOT_SYNTHETIC', null);
    if (!ports.provider.baaCovered) return outcome('NO_BAA', null);
  }

  const check = async (name: string): Promise<void> => {
    ports.boundary(name);
    if (!authorityCurrent(trusted, ports)) throw new Error('AUTHORITY_HELD');
    if (run && expired(run, ports.clock.utcNowMs(), ports.clock.monotonicNowMs())) throw new Error('DEADLINE');
    if (run) {
      const now = await ports.store.get(run.id);
      if (now.sequence !== run.sequence || now.fence !== run.fence || terminal(now.state)) throw new Error('STALE_FENCE');
    }
  };
  const advance = async (state: State): Promise<void> => {
    const next = run ? await ports.store.advance(run, state) : null;
    if (!next) throw new Error('STALE_FENCE');
    run = next;
  };
  const call = async (prompt: { prompt: string; templateDigest: string }, maxOutputUnits: number) => {
    modelCalls++;
    templateDigest ??= prompt.templateDigest;
    return ports.model.complete({ prompt: prompt.prompt, templateDigest: prompt.templateDigest, maxOutputUnits });
  };

  const begin = async (attemptId: string): Promise<boolean> => {
    const started = await ports.budgets.begin(run!.id, attemptId);
    if (started) usage.pending++;
    return started;
  };
  /** Units count as known once the provider has reported well-formed numbers, even if they break a cap; a missing or malformed report leaves the usage unknown. */
  const observe = async (role: 'draft' | 'verify', attemptId: string, observation: Observation | null): Promise<boolean> => {
    const ok = await ports.budgets.observe(run!.id, role, attemptId, observation);
    if (
      observation &&
      Number.isSafeInteger(observation.inputUnits) &&
      Number.isSafeInteger(observation.generatedUnits) &&
      observation.inputUnits >= 0 &&
      observation.generatedUnits >= 0
    ) {
      usage.input += observation.inputUnits;
      usage.generated += observation.generatedUnits;
      usage.pending--;
    }
    return ok;
  };

  try {
    await check('admission');
    // Keyed, because the store keeps it: the evidence is a small space, and a plain hash of it could be reversed by trying every candidate (FR-009).
    const tuple = keyedDigest(ports.digestKey, canonicalJson([request.dataMarker, engine.outcome, engine.reasonCode, engine.strength, engine.explainable]));
    const key = JSON.stringify([trusted.tenantId, trusted.requesterRef, EXPLAIN_TASK, request.idempotencyKey]);
    const admitted = await ports.store.admit(key, tuple, trusted, ports.harnessVersion, ports.clock.utcNowMs(), ports.clock.monotonicNowMs());
    if (admitted.run.tenantId !== trusted.tenantId || admitted.run.requesterRef !== trusted.requesterRef) return outcome('CONTROL_HELD', 'STORE_BINDING');
    // An existing run is another request's: report on it, never settle it. The harness stores no explanation text (FR-014), so a replay returns the engine text only.
    if (admitted.kind === 'conflict') return outcome('IDEMPOTENCY_CONFLICT', null);
    if (admitted.kind === 'existing') return outcome(terminal(admitted.run.state) ? 'IDEMPOTENT_REPLAY' : 'IN_PROGRESS', null);
    run = admitted.run;
    mark('admission');
    if (!(await ports.budgets.reserve(run))) return fail('BUDGET_HELD');
    await advance('queued');
    await check('retrieve');
    await advance('running');
    if (!eligible.eligible) return fail('NOT_ELIGIBLE', eligible.reason);
    if (!explainable.success) return fail('INPUT_REFUSED');
    const result = explainable.data;

    let reasons: string[] = [];
    for (let attempt = 1; attempt <= EXPLAIN_LIMITS.draftAttempts; attempt++) {
      await check('draft');
      let drafting;
      try {
        drafting = attempt === 1 ? buildPrompt(result) : buildRepairPrompt(result, reasons);
      } catch {
        return fail('INPUT_REFUSED');
      }
      const draftAttempt = `${run!.id}:draft:${attempt}`;
      if (!(await begin(draftAttempt))) return fail('USAGE_HELD');
      let reply;
      try {
        reply = await call(drafting, 768);
      } catch {
        return fail('MODEL_ERROR');
      }
      await check('draft-complete');
      artifact.present = true;
      artifact.value = reply.artifact;
      const observed = await observe('draft', draftAttempt, reply.observation);
      mark('draft', observed ? null : 'USAGE_HELD');
      if (!observed) return fail('USAGE_HELD');
      if (refusalSchema.safeParse(reply.artifact).success) return fail('MODEL_REFUSED');
      await advance('reviewing');

      const explanation = explanationSchema.safeParse(reply.artifact);
      if (explanation.success && guards.length === 0) guards.push(...SENSORS);
      reasons = explanation.success ? [...new Set(runSensors(explanation.data, result).map((h) => h.reason))] : ['INVALID_STRUCTURE'];
      mark('sensors', reasons.length > 0 ? (explanation.success ? 'SENSOR_HOLD' : 'INVALID_STRUCTURE') : null);
      if (reasons.length > 0) {
        if (attempt >= EXPLAIN_LIMITS.draftAttempts) return fail(explanation.success ? 'SENSOR_HOLD' : 'INVALID_STRUCTURE', reasons.join(','));
        await advance('repair-pending');
        await advance('running');
        continue;
      }
      if (!explanation.success) return fail('CONTROL_HELD');

      // The verifier is called only for an explanation every sensor passed, and it can only add a hold.
      await check('verify');
      const verifying = buildVerifierPrompt(result, explanation.data);
      const verifyAttempt = `${run!.id}:verify:${attempt}`;
      if (!(await begin(verifyAttempt))) return fail('USAGE_HELD');
      let judged;
      try {
        judged = await call(verifying, 1024);
      } catch {
        return fail('MODEL_ERROR');
      }
      await check('verify-complete');
      const judgedOk = await observe('verify', verifyAttempt, judged.observation);
      if (!judgedOk) {
        mark('verify', 'USAGE_HELD');
        return fail('USAGE_HELD');
      }
      guards.push('VERIFIER');
      const verdict = checkVerifierReply(judged.artifact, explanation.data);
      mark('verify', verdict.ok ? null : 'VERIFIER_HOLD');
      if (!verdict.ok) return fail('VERIFIER_HOLD', verdict.reason);

      await advance('release-pending');
      await check('release');
      await advance('released');
      await ports.budgets.complete(run!.id);
      mark('release');
      artifact.value = explanation.data;
      return {
        released: true,
        reasonCode: 'RELEASED',
        label: EXPLANATION_LABEL,
        explanation: explanation.data,
        ...(await seal('RELEASED', null, true)),
      };
    }
    return fail('SENSOR_HOLD', reasons.join(','));
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    if (run && expired(run, ports.clock.utcNowMs(), ports.clock.monotonicNowMs())) return fail('DEADLINE', null, 'expired');
    if (message === 'AUTHORITY_HELD') return fail('AUTHORITY_HELD');
    return fail('CONTROL_HELD', FIXED_CAUSES.has(message) ? message : null);
  }
}
