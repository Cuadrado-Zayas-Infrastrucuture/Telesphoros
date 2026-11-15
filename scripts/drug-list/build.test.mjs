import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build, brandTargets, candidates, ingredient, mapLimited, prescribableConcepts } from './build.mjs';
// Invented codes and names: filter fixtures, never product drug data.
test('CPIC candidates exclude other vocabularies, missing and malformed codes and deduplicate', () => {
  assert.deepEqual(candidates([{drugid:'RxNorm:991001'}, {drugid:'RxNorm:991001'}, {drugid:'ATC:N01'}, {drugid:'RxNorm:NA'}, {drugid:'RxNorm:12x'}, {drugid:'RxNorm:0'}, {}]), ['991001']);
});
test('only matching IN and MIN properties enter the list, using the source name', () => {
  assert.equal(ingredient('991001', {rxcui:'991001',tty:'SCD',name:'synthetic'}, 'fixture'), null);
  assert.equal(ingredient('991001', {rxcui:'991002',tty:'IN',name:'synthetic'}, 'fixture'), null);
  assert.equal(ingredient('991001', undefined, 'fixture'), null);
  for (const tty of ['IN','MIN']) assert.deepEqual(ingredient('991001', {rxcui:'991001',tty,name:'synthetic ingredient'}, 'fixture'), {rxcui:'991001',tty,name:'synthetic ingredient',displayName:'synthetic ingredient',rxnormRelease:'fixture'});
});
const group = (rows) => ({ minConceptGroup: { minConcept: rows } });
test('prescribable rows of the asked type pass; empty, mistyped or malformed rows refuse the build', () => {
  assert.deepEqual(prescribableConcepts(group([{rxcui:'991001',name:'synthetic ingredient',tty:'IN'}]), 'IN'), [{rxcui:'991001',name:'synthetic ingredient',tty:'IN'}]);
  assert.throws(() => prescribableConcepts(group([]), 'IN'), /no prescribable IN/);
  assert.throws(() => prescribableConcepts({}, 'BN'), /no prescribable BN/);
  for (const row of [{rxcui:'991001',name:'synthetic',tty:'MIN'}, {rxcui:'0',name:'synthetic',tty:'IN'}, {rxcui:'991001',name:' ',tty:'IN'}, {rxcui:'991001',tty:'IN'}])
    assert.throws(() => prescribableConcepts(group([row]), 'IN'), /malformed/);
});
const related = (byTty) => ({ relatedGroup: { rxcui: null, conceptGroup: Object.entries(byTty).map(([tty, codes]) => ({ tty, conceptProperties: codes.map((rxcui) => ({ rxcui, name: `synthetic ${rxcui}`, tty })) })) } });
test('a brand points to its combination when there is one, else to its single ingredient, else nowhere', () => {
  const listed = new Map(['991001', '991002', '991003', '991010', '991011'].map((rxcui) => [rxcui, {}]));
  assert.deepEqual(brandTargets(related({ IN: ['991001'] }), listed), ['991001']);
  assert.deepEqual(brandTargets(related({ IN: ['991001', '991002'], MIN: ['991010'] }), listed), ['991010']);
  assert.deepEqual(brandTargets(related({ IN: ['991001', '991002', '991003'], MIN: ['991011', '991010'] }), listed), ['991010', '991011']);
  // Ambiguous: several ingredients and no combination concept. Never guessed.
  assert.deepEqual(brandTargets(related({ IN: ['991001', '991002'] }), listed), []);
  // Targets outside the list are ignored, never added.
  assert.deepEqual(brandTargets(related({ IN: ['999999'] }), listed), []);
  assert.deepEqual(brandTargets(related({ IN: ['991001'], MIN: ['999999'] }), listed), ['991001']);
  assert.deepEqual(brandTargets({ relatedGroup: { conceptGroup: [{ tty: 'IN' }] } }, listed), []);
  assert.throws(() => brandTargets({}, listed), /no related-concept groups/);
});
test('the request pool keeps its limit and returns results in input order', async () => {
  let active = 0;
  let peak = 0;
  const out = await mapLimited([5, 1, 4, 2, 3, 0], async (n) => {
    peak = Math.max(peak, ++active);
    await new Promise((done) => setTimeout(done, n));
    active--;
    return n * 10;
  }, 2, 0);
  assert.deepEqual(out, [50, 10, 40, 20, 30, 0]);
  assert.equal(peak, 2);
});
/** A synthetic source set: one CPIC ingredient, two prescribable ingredients, one combination and three brands. */
function sources({ versions = () => 'fixture', cpicName = 'synthetic alpha', brandRelated } = {}) {
  const calls = [];
  const get = async (url) => {
    calls.push(url);
    if (url.includes('releases/latest')) return {tag_name:'v1.61.0',html_url:'https://github.com/cpicpgx/cpic-data/releases/tag/v1.61.0'};
    if (url.endsWith('/REST/version.json')) return {version: versions()};
    if (url.endsWith('/drug')) return [{drugid:'RxNorm:991001'}, {drugid:'RxNorm:991009'}];
    if (url.endsWith('/rxcui/991001/properties.json')) return {properties:{rxcui:'991001',tty:'IN',name:'synthetic alpha'}};
    if (url.endsWith('/rxcui/991009/properties.json')) return {properties:{rxcui:'991009',tty:'IN',name:'synthetic cpic only'}};
    if (url.endsWith('allconcepts.json?tty=IN')) return group([{rxcui:'991001',name:cpicName,tty:'IN'}, {rxcui:'991002',name:'synthetic beta',tty:'IN'}, {rxcui:'991003',name:'hydroxyzine',tty:'IN'}]);
    if (url.endsWith('allconcepts.json?tty=MIN')) return group([{rxcui:'991010',name:'synthetic alpha / synthetic beta',tty:'MIN'}]);
    if (url.endsWith('allconcepts.json?tty=BN')) return group([{rxcui:'992001',name:'Synthabrand',tty:'BN'}, {rxcui:'992002',name:'Combobrand',tty:'BN'}, {rxcui:'992003',name:'Puzzlebrand',tty:'BN'}]);
    const brand = /\/Prescribe\/rxcui\/(\d+)\/related\.json\?tty=IN\+MIN$/.exec(url)?.[1];
    if (brand && brandRelated) return brandRelated(brand);
    if (brand === '992001') return related({ IN: ['991001'] });
    if (brand === '992002') return related({ IN: ['991001', '991002'], MIN: ['991010'] });
    if (brand === '992003') return related({ IN: ['991001', '991002'] });
    throw new Error(`unexpected request ${url}`);
  };
  return { get, calls };
}
test('the list keeps every CPIC ingredient, adds prescribable ingredients and maps brands as aliases only', async () => {
  const { get } = sources();
  const list = await build(get, new Date('2026-11-14T00:00:00.000Z'), { spacingMs: 0 });
  assert.equal(list.prescribableSource, 'https://rxnav.nlm.nih.gov/REST/Prescribe/allconcepts.json');
  assert.deepEqual(list.entries.map((entry) => entry.rxcui), ['991003', '991001', '991010', '991002', '991009']);
  assert.deepEqual(list.sourceProperties.map((p) => p.rxcui), ['991001', '991002', '991003', '991009', '991010']);
  const byCode = Object.fromEntries(list.entries.map((entry) => [entry.rxcui, entry]));
  assert.deepEqual(byCode['991001'].brands, [{ rxcui: '992001', name: 'Synthabrand' }]);
  assert.deepEqual(byCode['991010'].brands, [{ rxcui: '992002', name: 'Combobrand' }]);
  assert.equal(byCode['991002'].brands, undefined);
  assert.equal(byCode['991003'].displayName, 'hydrOXYzine');
  assert.deepEqual(list.brandProperties, [
    { rxcui: '992001', name: 'Synthabrand', tty: 'BN', ingredients: ['991001'] },
    { rxcui: '992002', name: 'Combobrand', tty: 'BN', ingredients: ['991010'] },
  ]);
  assert.ok(list.citations.some((citation) => citation.includes('prescribe.html')));
});
test('network failure, release drift, source disagreement and a failed brand lookup refuse the whole artifact', async () => {
  await assert.rejects(build(async () => { throw new Error('source unavailable'); }), /source unavailable/);
  let versions = 0;
  await assert.rejects(build(sources({ versions: () => (++versions === 1 ? 'fixture-a' : 'fixture-b') }).get, new Date(), { spacingMs: 0 }), /changed during generation/);
  await assert.rejects(build(sources({ cpicName: 'synthetic renamed' }).get, new Date(), { spacingMs: 0 }), /sources disagree/);
  await assert.rejects(build(sources({ brandRelated: () => { throw new Error('brand lookup failed'); } }).get, new Date(), { spacingMs: 0 }), /brand lookup failed/);
});
test('a listed name stays canonical while only its display name uses Tall Man', () => {
  const entry = ingredient('991001', {rxcui:'991001',tty:'IN',name:'hydroxyzine'}, 'synthetic-fixture');
  assert.equal(entry.name, 'hydroxyzine');
  assert.equal(entry.displayName, 'hydrOXYzine');
});
