import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { RESULTS } from '../evals/golden/results';
import { runExplanation } from '../src/explain';
import { EXPLAIN_TASK } from '../src/explain-contracts';
import { GUARDS, PHI_TEMPLATE_FIELDS, taskProblems, TASKS, type TaskDeclaration } from '../src/tasks';
import { TEMPLATE_V1 } from '../src/prompts/explain-v1';
import { explainScenario } from './helpers/explain-adapters';
import { exportsOf, guardsWithoutCaller, mentions, srcFiles } from './helpers/guard-callers';

const root = fileURLToPath(new URL('..', import.meta.url));
const real = TASKS[EXPLAIN_TASK];
const withTask = (patch: Partial<TaskDeclaration>) => ({ [EXPLAIN_TASK]: { ...real, ...patch } });

describe('R1: every task declares its data class, and the declaration is held', () => {
  test('the real registry has no problem (control)', () => expect(taskProblems(TASKS)).toEqual([]));
  test('the explanation task is phi, and its prompt fields are the template placeholders', () => {
    expect(real.dataClass).toBe('phi');
    expect([...TEMPLATE_V1.matchAll(/\{\{(\w+)\}\}/g)].map(m => m[1]).sort()).toEqual([...real.promptFields].sort());
  });
  test('a task with no declaration is reported', () => expect(taskProblems(withTask({ dataClass: undefined }))).toContain(`${EXPLAIN_TASK}: R1_NO_DECLARATION`));
  test('a no-phi declaration on a prompt that carries one person\'s phenotype is reported', () => {
    expect(PHI_TEMPLATE_FIELDS).toContain('genes');
    expect(taskProblems(withTask({ dataClass: 'no-phi' }))).toContain(`${EXPLAIN_TASK}: R1_CLASS_DISAGREES`);
  });
  test('a phi task whose provider filter is not BAA-only is reported', () => expect(taskProblems(withTask({ provider: 'any' }))).toContain(`${EXPLAIN_TASK}: R1_PROVIDER_FILTER`));
  test('declared prompt fields that differ from what the template uses are reported', () => expect(taskProblems(withTask({ promptFields: ['drug'] }))).toContain(`${EXPLAIN_TASK}: R1_PROMPT_FIELDS_DRIFT`));
});

describe('R4: the output class is declared and the listed checks match it', () => {
  test('a free-text task with no listed checks is reported', () => expect(taskProblems(withTask({ checks: [] }))).toContain(`${EXPLAIN_TASK}: R4_NO_CHECKS`));
  test('a free-text task missing a sensor from its list is reported', () => expect(taskProblems(withTask({ checks: real.checks.filter(c => c !== 'S4') }))).toContain(`${EXPLAIN_TASK}: R4_CHECKS_DISAGREE`));
  test('a check that is not a known guard is reported', () => expect(taskProblems(withTask({ checks: [...real.checks, 'S9'] }))).toEqual(expect.arrayContaining([`${EXPLAIN_TASK}: R2_UNKNOWN_GUARD`])));
  test('an undeclared output class is reported', () => expect(taskProblems(withTask({ output: undefined }))).toContain(`${EXPLAIN_TASK}: R4_NO_OUTPUT_CLASS`));
  test('at run time the guards that actually ran are exactly the listed checks', async () => {
    const o = await runExplanation(explainScenario().request, explainScenario().context, explainScenario().ports);
    expect(o.released).toBe(true);
    expect(o.guardsRun).toEqual([...real.checks]);
  });
  test('a run that skipped a listed guard would show it: the listed set is compared in order and in full', () => expect([...real.checks].slice(1)).not.toEqual([...real.checks]));
});

describe('R2: every output guard has a production caller', () => {
  const files = srcFiles(root);
  test('every guard entry point is mentioned by a source file other than its own', () => expect(guardsWithoutCaller(files, GUARDS)).toEqual([]));
  test('broken on purpose: without explain.ts the guards have no caller and the check reports them', () => {
    const rest = Object.fromEntries(Object.entries(files).filter(([k]) => k !== 'explain.ts'));
    expect(guardsWithoutCaller(rest, GUARDS).length).toBeGreaterThan(0);
  });
  test('broken on purpose: a copy of explain.ts that never calls the verifier is reported', () => {
    const edited = { ...files, 'explain.ts': files['explain.ts'].replaceAll('checkVerifierReply', 'checkNothing') };
    expect(guardsWithoutCaller(edited, GUARDS)).toContain('VERIFIER');
  });
  test('every export of a guard module is a listed guard, a registry, or a sensor in the registry (no unlisted guard can be added silently)', () => {
    const allowed = new Set(['s1', 's2', 's3', 's4', 's5', 's6', 'ALL_SENSORS', 'runSensors', 'KNOWN_HOLD_REASONS', 'verifierReplySchema', 'checkVerifierReply']);
    for (const m of ['evaluators/sensors.ts', 'evaluators/verifier.ts']) for (const name of exportsOf(m, files[m])) expect(allowed.has(name), `${m} exports ${name}: list it as a guard in tasks.ts or here`).toBe(true);
    for (const s of ['s1', 's2', 's3', 's4', 's5', 's6']) expect(files['evaluators/sensors.ts']).toMatch(new RegExp(`S\\d: ${s}\\b`));
  });
  test('explain.ts reaches the sensors only through runSensors, the verifier only through checkVerifierReply', () => {
    expect(mentions('explain.ts', files['explain.ts'], 'runSensors')).toBe(true);
    expect(mentions('explain.ts', files['explain.ts'], 'checkVerifierReply')).toBe(true);
  });
  test('the registry names the result fields only as data (sanity: RESULTS is a valid explainable input)', () => expect(Object.keys(RESULTS.avoid)).toContain('genes'));
});
