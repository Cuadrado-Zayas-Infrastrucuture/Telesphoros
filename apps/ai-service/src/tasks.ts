import { EXPLAIN_TASK } from './explain-contracts';
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
/** Prompt fields that carry one person's genotype or phenotype: health information about an individual, so the task is `phi` (R1). */
export const PHI_TEMPLATE_FIELDS = ['genes'] as const;

/** Each guard and the entry point a production file must call. The sensors are reached through runSensors, the verifier through checkVerifierReply. */
export const GUARDS: Readonly<Record<string, { symbol: string; module: string }>> = {
  S1: { symbol: 'runSensors', module: 'evaluators/sensors.ts' },
  S2: { symbol: 'runSensors', module: 'evaluators/sensors.ts' },
  S3: { symbol: 'runSensors', module: 'evaluators/sensors.ts' },
  S4: { symbol: 'runSensors', module: 'evaluators/sensors.ts' },
  S5: { symbol: 'runSensors', module: 'evaluators/sensors.ts' },
  S6: { symbol: 'runSensors', module: 'evaluators/sensors.ts' },
  VERIFIER: { symbol: 'checkVerifierReply', module: 'evaluators/verifier.ts' },
};
export const FREE_TEXT_CHECKS: readonly string[] = ['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'VERIFIER'];
const TEMPLATES: Readonly<Record<string, string>> = { [EXPLAIN_TASK]: TEMPLATE_V1 };

export const TASKS: Readonly<Record<string, TaskDeclaration>> = {
  [EXPLAIN_TASK]: {
    dataClass: 'phi',
    output: 'free-text',
    checks: FREE_TEXT_CHECKS,
    provider: 'baa-required',
    promptFields: ['drug', 'strength', 'genes', 'guidelineId', 'guidelineVersion', 'locator', 'recommendationText', 'implication'],
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
      else if (FREE_TEXT_CHECKS.some((c) => !checks.includes(c))) say('R4_CHECKS_DISAGREE');
    }
    if (checks.some((c) => !Object.hasOwn(GUARDS, c))) say('R2_UNKNOWN_GUARD');
  }
  return out;
}
