import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { evaluationResultSchema, INDETERMINATE_REASON_CODES } from '@telesphoros/cpic-schema';
import { loadKnowledge } from '../knowledge/knowledge-loader';
import type { KnowledgeSet } from '../knowledge/knowledge-set';
import { SCENARIO_DIR, SYNTHETIC_DIR } from '../../../test/helpers/knowledge';
import { evaluate } from './recommendation-engine';

interface Scenario {
  name: string;
  description: string;
  calls: never[];
  drugs?: string[];
  expected: { knowledgeSetId: string; phenotypes: unknown[]; recommendations: unknown[] };
}

let knowledge: KnowledgeSet;
let scenarios: Scenario[];

beforeAll(async () => {
  knowledge = await loadKnowledge({ directory: SYNTHETIC_DIR, mode: 'non-production' });
  const names = (await readdir(SCENARIO_DIR)).filter((name) => name.endsWith('.json')).sort();
  scenarios = await Promise.all(names.map(async (name) => JSON.parse(await readFile(join(SCENARIO_DIR, name), 'utf8')) as Scenario));
});

describe('clinical scenarios (golden results, written by hand from the rules)', () => {
  it('the scenario set is real: enough scenarios, each named after its file', async () => {
    expect(scenarios.length).toBeGreaterThanOrEqual(15);
    const names = (await readdir(SCENARIO_DIR)).filter((name) => name.endsWith('.json')).sort();
    expect(scenarios.map((s) => `${s.name}.json`)).toEqual(names);
  });

  it('covers every outcome class: a recommendation, each reason the fixtures can produce, and a missing guideline', () => {
    const text = JSON.stringify(scenarios.map((s) => s.expected));
    expect(text).toContain('"status":"recommendation"');
    // STRUCTURAL_VARIANT and MULTIALLELIC_SITE come from parsers and share the pass-through path tested in recommendation-engine.spec.
    const parserOnly = ['STRUCTURAL_VARIANT', 'MULTIALLELIC_SITE'];
    for (const code of INDETERMINATE_REASON_CODES.filter((c) => !parserOnly.includes(c))) {
      expect(`${code}: ${text.includes(`"reasonCode":"${code}"`)}`).toBe(`${code}: true`);
    }
  });

  it('every scenario produces exactly its expected result', () => {
    for (const scenario of scenarios) {
      const expected = JSON.parse(JSON.stringify(scenario.expected).replaceAll('$KNOWLEDGE_SET_ID', knowledge.id));
      const actual = evaluate(knowledge, scenario.calls, scenario.drugs === undefined ? {} : { drugs: scenario.drugs });
      expect({ scenario: scenario.name, result: actual }).toEqual({ scenario: scenario.name, result: expected });
      expect(evaluationResultSchema.safeParse(actual).success).toBe(true);
    }
  });
});
