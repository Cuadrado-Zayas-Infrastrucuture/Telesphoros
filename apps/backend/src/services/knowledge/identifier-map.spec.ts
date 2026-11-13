import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SYNTHETIC_DIR } from '../../../test/helpers/knowledge';
import { type IngredientMatch, mapRxNormIngredients } from './identifier-map';
import { loadKnowledge } from './knowledge-loader';
import { KnowledgeSet } from './knowledge-set';

const MAP_DIR = join(SYNTHETIC_DIR, '../identifier-map');
const CONTROL_DIR = join(SYNTHETIC_DIR, '../identifier-conflicts/control');
// The answers were written by hand before the function (spec 039 T2).
const expected = JSON.parse(readFileSync(join(MAP_DIR, 'expected.json'), 'utf8')) as { ids: string[]; answers: IngredientMatch[] };
const mapSet = () => loadKnowledge({ directory: join(MAP_DIR, 'set'), mode: 'non-production' });

describe('mapRxNormIngredients (spec 039 IK-4)', () => {
  it('gives the written answer for every id, in the order the ids were given', async () => {
    expect(expected.ids).toHaveLength(9);
    expect(mapRxNormIngredients(await mapSet(), expected.ids)).toEqual(expected.answers);
  });

  it('answers a repeated id again in its own place', async () => {
    const answers = mapRxNormIngredients(await mapSet(), ['syn-rxcui-drugq', 'syn-rxcui-unknown', 'syn-rxcui-drugq']);
    expect(answers.map((answer) => answer.rxcui)).toEqual(['syn-rxcui-drugq', 'syn-rxcui-unknown', 'syn-rxcui-drugq']);
    expect(answers[2]).toEqual(answers[0]);
  });

  it('lists every guideline file of the drug, sorted by id, and names the file that supersedes one', async () => {
    const [answer] = mapRxNormIngredients(await mapSet(), ['syn-rxcui-drugz']);
    expect(answer).toEqual({
      rxcui: 'syn-rxcui-drugz',
      status: 'matched',
      drug: 'drugz',
      guidelines: [
        { id: 'drugz-genea', supersededBy: 'drugz-genea-geneb' },
        { id: 'drugz-genea-geneb', supersededBy: null },
      ],
    });
  });

  it('never matches a drug by its name, even a name spelled like an identifier', async () => {
    const answers = mapRxNormIngredients(await mapSet(), ['syn-rxcui-drugr', 'drugq', 'drugz']);
    expect(answers).toEqual([
      { rxcui: 'syn-rxcui-drugr', status: 'not-matched', reason: 'no-identified-guideline' },
      { rxcui: 'drugq', status: 'not-matched', reason: 'invalid-identifier' },
      { rxcui: 'drugz', status: 'not-matched', reason: 'invalid-identifier' },
    ]);
  });

  it('treats a well-formed id of either form alike, whatever the set holds: not matched, never invalid', async () => {
    const ids = ['990000000001', 'syn-rxcui-drugq', '0042', '', ' 990000000001', 'syn-rxcui-', 'SYN-RXCUI-DRUGQ'];
    const want = [
      { rxcui: '990000000001', status: 'not-matched', reason: 'no-identified-guideline' },
      { rxcui: 'syn-rxcui-drugq', status: 'not-matched', reason: 'no-identified-guideline' },
      { rxcui: '0042', status: 'not-matched', reason: 'invalid-identifier' },
      { rxcui: '', status: 'not-matched', reason: 'invalid-identifier' },
      { rxcui: ' 990000000001', status: 'not-matched', reason: 'invalid-identifier' },
      { rxcui: 'syn-rxcui-', status: 'not-matched', reason: 'invalid-identifier' },
      { rxcui: 'SYN-RXCUI-DRUGQ', status: 'not-matched', reason: 'invalid-identifier' },
    ];
    expect(mapRxNormIngredients(new KnowledgeSet('empty', 'non-production', [], [], []), ids)).toEqual(want);
    // A synthetic set answers a well-formed digits id the same way: not matched, because no guideline in it states that id.
    const control = await loadKnowledge({ directory: CONTROL_DIR, mode: 'non-production' });
    expect(mapRxNormIngredients(control, ids.slice(0, 1))).toEqual(want.slice(0, 1));
  });

  it('never matches a drug that only schema 1.2 files describe', async () => {
    const control = await loadKnowledge({ directory: CONTROL_DIR, mode: 'non-production' });
    const answers = mapRxNormIngredients(control, ['drugt', 'syn-rxcui-drugt', 'syn-rxcui-drugq', 'syn-rxcui-drugs']);
    expect(answers).toEqual([
      { rxcui: 'drugt', status: 'not-matched', reason: 'invalid-identifier' },
      { rxcui: 'syn-rxcui-drugt', status: 'not-matched', reason: 'no-identified-guideline' },
      {
        rxcui: 'syn-rxcui-drugq',
        status: 'matched',
        drug: 'drugq',
        guidelines: [
          { id: 'drugq-genea', supersededBy: null },
          { id: 'drugq-geneb', supersededBy: null },
        ],
      },
      { rxcui: 'syn-rxcui-drugs', status: 'matched', drug: 'drugs', guidelines: [{ id: 'drugs-genec', supersededBy: null }] },
    ]);
  });

  it('answers an empty list with an empty list, and leaves the list it was given as it was', async () => {
    const set = await mapSet();
    expect(mapRxNormIngredients(set, [])).toEqual([]);
    const ids = Object.freeze([...expected.ids]);
    mapRxNormIngredients(set, ids);
    expect(ids).toEqual(expected.ids);
  });
});

describe('mapRxNormIngredients: no content, no logging, the same answers every time (spec 039 IK-8, IK-9)', () => {
  it('carries only the id, the status, the drug, the file ids and the reason', async () => {
    for (const answer of mapRxNormIngredients(await mapSet(), expected.ids)) {
      if (answer.status === 'matched') {
        expect(Object.keys(answer).sort()).toEqual(['drug', 'guidelines', 'rxcui', 'status']);
        for (const guideline of answer.guidelines) expect(Object.keys(guideline).sort()).toEqual(['id', 'supersededBy']);
      } else {
        expect(Object.keys(answer).sort()).toEqual(['reason', 'rxcui', 'status']);
      }
    }
  });

  it('writes nothing to the console or the process streams', async () => {
    const set = await mapSet();
    const spies = [
      ...(['log', 'info', 'warn', 'error', 'debug', 'trace'] as const).map((method) => jest.spyOn(console, method)),
      jest.spyOn(process.stdout, 'write'),
      jest.spyOn(process.stderr, 'write'),
    ];
    try {
      mapRxNormIngredients(set, expected.ids);
      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });

  it('gives the same answers twice, and from a set built with its files in reversed order', async () => {
    const set = await mapSet();
    expect(mapRxNormIngredients(set, expected.ids)).toEqual(mapRxNormIngredients(set, expected.ids));
    // The loader sorts the files it reads, so order is tested on the set itself.
    const reversed = new KnowledgeSet(set.id, set.mode, [...set.allGeneMaps()].reverse(), [...set.allGuidelines()].reverse(), [...set.files].reverse());
    expect(mapRxNormIngredients(reversed, expected.ids)).toEqual(expected.answers);
  });

  it('leaves the knowledge set as it was', async () => {
    const set = await mapSet();
    const before = JSON.stringify({ maps: set.allGeneMaps(), guidelines: set.allGuidelines(), files: set.files });
    mapRxNormIngredients(set, expected.ids);
    expect(JSON.stringify({ maps: set.allGeneMaps(), guidelines: set.allGuidelines(), files: set.files })).toBe(before);
  });
});
