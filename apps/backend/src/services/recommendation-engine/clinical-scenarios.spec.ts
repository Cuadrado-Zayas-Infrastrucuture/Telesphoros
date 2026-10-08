import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { evaluationResultSchema, type GeneInput, OUTCOMES, REASON_CODES } from '@telesphoros/cpic-schema';
import { loadKnowledge } from '../knowledge/knowledge-loader';
import type { KnowledgeSet } from '../knowledge/knowledge-set';
import { SCENARIO_DIR, SYNTHETIC_DIR } from '../../../test/helpers/knowledge';
import { evaluate } from './recommendation-engine';

interface Scenario {
  name: string;
  description: string;
  inputs: GeneInput[];
  drugs?: string[];
  expected: { knowledgeSetId: string; geneStates: unknown[]; results: { outcome: string; reasonCode?: string }[] };
}

let knowledge: KnowledgeSet;
let scenarios: Scenario[];

beforeAll(async () => {
  knowledge = await loadKnowledge({ directory: SYNTHETIC_DIR, mode: 'non-production' });
  const names = (await readdir(SCENARIO_DIR)).filter((name) => name.endsWith('.json')).sort();
  scenarios = await Promise.all(names.map(async (name) => JSON.parse(await readFile(join(SCENARIO_DIR, name), 'utf8')) as Scenario));
});

const resolved = (scenario: Scenario) => JSON.parse(JSON.stringify(scenario.expected).replaceAll('$KNOWLEDGE_SET_ID', knowledge.id));

describe('clinical scenarios (golden results, written by hand from the rules)', () => {
  it('the scenario set is real: enough scenarios, each named after its file', async () => {
    expect(scenarios.length).toBeGreaterThanOrEqual(29);
    const names = (await readdir(SCENARIO_DIR)).filter((name) => name.endsWith('.json')).sort();
    expect(scenarios.map((s) => `${s.name}.json`)).toEqual(names);
  });

  it('covers every outcome and every reason code in the vocabulary', () => {
    const text = JSON.stringify(scenarios.map((s) => s.expected));
    for (const outcome of OUTCOMES) expect(`${outcome}: ${text.includes(`"outcome":"${outcome}"`)}`).toBe(`${outcome}: true`);
    for (const code of REASON_CODES) expect(`${code}: ${text.includes(`"reasonCode":"${code}"`)}`).toBe(`${code}: true`);
  });

  it('every hand-written expectation is itself a well-formed result (a typo in a golden file cannot pass silently)', () => {
    for (const scenario of scenarios) {
      expect({ scenario: scenario.name, valid: evaluationResultSchema.safeParse(resolved(scenario)).success }).toEqual({ scenario: scenario.name, valid: true });
    }
  });

  it('every scenario produces exactly its expected result', () => {
    for (const scenario of scenarios) {
      const actual = evaluate(knowledge, scenario.inputs, scenario.drugs === undefined ? {} : { drugs: scenario.drugs });
      expect({ scenario: scenario.name, result: actual }).toEqual({ scenario: scenario.name, result: resolved(scenario) });
    }
  });
});
