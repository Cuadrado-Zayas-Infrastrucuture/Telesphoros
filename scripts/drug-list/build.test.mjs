import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build, candidates, ingredient } from './build.mjs';
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
test('network failure and release drift refuse the whole artifact', async () => {
  await assert.rejects(build(async () => { throw new Error('source unavailable'); }), /source unavailable/);
  let versions = 0;
  await assert.rejects(build(async (url) => {
    if (url.includes('releases/latest')) return {tag_name:'v1.61.0',html_url:'https://github.com/cpicpgx/cpic-data/releases/tag/v1.61.0'};
    if (url.endsWith('version.json')) return {version: ++versions === 1 ? 'fixture-a' : 'fixture-b'};
    if (url.endsWith('/drug')) return [{drugid:'RxNorm:991001'}];
    return {properties:{rxcui:'991001',tty:'IN',name:'synthetic ingredient'}};
  }), /changed during generation/);
});
test('a listed name stays canonical while only its display name uses Tall Man', () => {
  const entry = ingredient('991001', {rxcui:'991001',tty:'IN',name:'hydroxyzine'}, 'synthetic-fixture');
  assert.equal(entry.name, 'hydroxyzine');
  assert.equal(entry.displayName, 'hydrOXYzine');
});
