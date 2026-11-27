import { EXPLAIN_TASK } from './explain-contracts';
import { HELP_TASK } from './help/contracts';
import { HELP_TEMPLATE_V1 } from './help/prompt-v1';
import { TEMPLATE_V1 } from './prompts/explain-v1';

export type DataClass = 'phi' | 'no-phi';
/** What a task declares in code (R1, R4). Fields are optional so a registry missing a declaration can be described and refused. */
export interface TaskDeclaration {
  dataClass: DataClass | undefined;
  output: 'structured' | 'free-text' | undefined;
  /** The guards listed beside the task (R2, R4). For free text they must be the full set below. */
  checks: readonly string[];
  /** The placeholders its prompt template fills. Compared with the template itself, so a new field cannot slip in under a no-phi label. */
  promptFields: readonly string[];
  provider: 'baa-required' | 'any';
}
/**
 * Prompt fields that can carry health information about an individual, so the task is `phi` (R1): one person's genotype or phenotype, and
 * the text a person types, which may hold anything (help lane, HC-D1).
 */
export const PHI_TEMPLATE_FIELDS = ['genes', 'question'] as const;

/** Each guard and the entry point a production file must call. The sensors are reached through runSensors, the verifier through checkVerifierReply. */
export const GUARDS: Readonly<Record<string, { symbol: string; module: string }>> = {
  S1: { symbol: 'runSensors', module: 'evaluators/sensors.ts' },
  S2: { symbol: 'runSensors', module: 'evaluators/sensors.ts' },
  S3: { symbol: 'runSensors', module: 'evaluators/sensors.ts' },
  S4: { symbol: 'runSensors', module: 'evaluators/sensors.ts' },
  S5: { symbol: 'runSensors', module: 'evaluators/sensors.ts' },
  S6: { symbol: 'runSensors', module: 'evaluators/sensors.ts' },
  VERIFIER: { symbol: 'checkVerifierReply', module: 'evaluators/verifier.ts' },
  // The help lane (help-lane.md FR-H3, FR-H5): its checks are reached through runHelpChecks, the model's own refusal through isOutOfScope.
  HC1: { symbol: 'runHelpChecks', module: 'help/checks.ts' },
  HC2: { symbol: 'runHelpChecks', module: 'help/checks.ts' },
  HC3: { symbol: 'runHelpChecks', module: 'help/checks.ts' },
  HC4: { symbol: 'runHelpChecks', module: 'help/checks.ts' },
  HC5: { symbol: 'runHelpChecks', module: 'help/checks.ts' },
  HC6: { symbol: 'runHelpChecks', module: 'help/checks.ts' },
  OUT_OF_SCOPE: { symbol: 'isOutOfScope', module: 'help/checks.ts' },
};
export const FREE_TEXT_CHECKS: readonly string[] = ['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'VERIFIER'];
/** The help lane's full set of checks (help-lane.md section 1): its own, not the clinical sensors, and no verifier (HC-D5). */
export const HELP_CHECKS_REQUIRED: readonly string[] = ['HC1', 'HC2', 'HC3', 'HC4', 'HC5', 'HC6', 'OUT_OF_SCOPE'];
/** The full set each free-text task must list. A task not named here must list the clinical set, the strictest. */
const REQUIRED_CHECKS: Readonly<Record<string, readonly string[]>> = { [EXPLAIN_TASK]: FREE_TEXT_CHECKS, [HELP_TASK]: HELP_CHECKS_REQUIRED };
const TEMPLATES: Readonly<Record<string, string>> = { [EXPLAIN_TASK]: TEMPLATE_V1, [HELP_TASK]: HELP_TEMPLATE_V1 };

export const TASKS: Readonly<Record<string, TaskDeclaration>> = {
  [EXPLAIN_TASK]: {
    dataClass: 'phi',
    output: 'free-text',
    checks: FREE_TEXT_CHECKS,
    provider: 'baa-required',
    promptFields: ['drug', 'strength', 'genes', 'guidelineId', 'guidelineVersion', 'locator', 'recommendationText', 'implication'],
  },
  [HELP_TASK]: {
    dataClass: 'phi',
    output: 'free-text',
    checks: HELP_CHECKS_REQUIRED,
    provider: 'baa-required',
    promptFields: ['screen', 'roles', 'articles', 'question'],
  },
};

/** Problems in a registry, as "task: CODE". Empty means every task is declared and its declaration agrees with itself and with its template. */
export function taskProblems(registry: Readonly<Record<string, Partial<TaskDeclaration>>>): string[] {
  const out: string[] = [];
  for (const [key, t] of Object.entries(registry)) {
    const say = (code: string) => out.push(`${key}: ${code}`);
    if (t.dataClass !== 'phi' && t.dataClass !== 'no-phi') say('R1_NO_DECLARATION');
    else {
      if (t.dataClass !== 'phi' && (t.promptFields ?? []).some((f) => (PHI_TEMPLATE_FIELDS as readonly string[]).includes(f))) say('R1_CLASS_DISAGREES');
      if (t.dataClass === 'phi' && t.provider !== 'baa-required') say('R1_PROVIDER_FILTER');
    }
    const template = TEMPLATES[key];
    if (
      template !== undefined &&
      [...template.matchAll(/\{\{(\w+)\}\}/g)]
        .map((m) => m[1])
        .sort()
        .join() !== [...(t.promptFields ?? [])].sort().join()
    )
      say('R1_PROMPT_FIELDS_DRIFT');
    if (t.output !== 'structured' && t.output !== 'free-text') say('R4_NO_OUTPUT_CLASS');
    const checks = t.checks ?? [];
    if (t.output === 'free-text') {
      if (checks.length === 0) say('R4_NO_CHECKS');
      else if ((REQUIRED_CHECKS[key] ?? FREE_TEXT_CHECKS).some((c) => !checks.includes(c))) say('R4_CHECKS_DISAGREE');
    }
    if (checks.some((c) => !Object.hasOwn(GUARDS, c))) say('R2_UNKNOWN_GUARD');
  }
  return out;
}
