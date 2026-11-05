import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fenceVars } from './fence-vars.mjs';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { coversAssessmentImage, coversFenceImage } from './fence-image-record.mjs';
import { record, mismatches } from './plan-record.mjs';
const privateLine = 'api_image = "SYN-PRIVATE-IMAGE"\nalarm_email = "SYN-PRIVATE-EMAIL"\n';
test('fence vars append or replace only the flag and preserve unrelated bytes', () => {
  assert.equal(fenceVars(privateLine, 'FENCE-CLOSE'), privateLine + 'medication_writes_enabled = false\n');
  assert.equal(fenceVars(privateLine + 'medication_writes_enabled = false\n', 'FENCE-OPEN'), privateLine + 'medication_writes_enabled = true\n');
  assert.equal(fenceVars(privateLine + 'medication_writes_enabled = true # approved\n', 'FENCE-CLOSE'), privateLine + 'medication_writes_enabled = false\n');
});
test('ambiguous HCL, duplicates and unsupported modes are rejected without values', () => {
  for (const text of ['medication_writes_enabled = 1', 'medication_writes_enabled = var.x', 'medication_writes_enabled = false\nmedication_writes_enabled = true',
    '/*\nmedication_writes_enabled = false\n*/', 'medication_writes_enabled = false\r\n', 'note = <<EOF\nmedication_writes_enabled = false\nEOF']) {
    assert.throws(() => fenceVars(text, 'FENCE-OPEN'));
  }
  assert.throws(() => fenceVars(privateLine, 'IMAGE'));
});
test('fence plan records bind both the canonical source and generated target var files', () => {
  const input = { mode: 'FENCE-CLOSE', head: 'a'.repeat(40), varSha256: 'b'.repeat(64), planSha256: 'c'.repeat(64), sourceVarSha256: 'd'.repeat(64), state: { serial: 7, lineage: 'synthetic' } };
  const saved = record(input);
  assert.equal(saved.sourceVarSha256, 'd'.repeat(64));
  assert.deepEqual(mismatches(saved, record(input)), []);
  assert.match(mismatches(saved, record({ ...input, sourceVarSha256: 'e'.repeat(64) }))[0], /sourceVarSha256/);
  assert.throws(() => record({ ...input, sourceVarSha256: undefined }));
});

test('opening record coverage rejects unsigned, wrong-image and wrong-stack records', () => {
  const image = '111122223333.dkr.ecr.us-east-2.amazonaws.com/telesphoros-staging-api@sha256:' + 'a'.repeat(64);
  const good = { format: 1, environment: 'staging', method: 'signature', images: [image], keyAlias: 'alias/telesphoros-staging-image-signing',
    keyArn: 'arn:aws:kms:us-east-2:111122223333:key/11111111-2222-4333-8444-555555555555', cosignVersion: 'v3.1.3', recordedAt: '2026-11-01T00:00:00Z' };
  assert.equal(coversFenceImage(good, image), true);
  for (const change of [{}, { method: 'break-glass' }, { images: [] }, { images: [image.replace(/a{64}$/, 'b'.repeat(64))] },
    { environment: 'production' }, { keyAlias: 'alias/other' },
    { keyArn: 'arn:aws:kms:us-east-2:999900001111:key/11111111-2222-4333-8444-555555555555' }, { keyArn: 'SYN-PRIVATE' }, { cosignVersion: 'v2.0.0' }]) {
    assert.equal(coversFenceImage(Object.keys(change).length ? { ...good, ...change } : {}, image), false);
  }
});

// ASSESSMENT-ON / ASSESSMENT-OFF (spec 032 S3, PR 3c-3a): the same discipline for synthetic_assessment_enabled.
test('assessment vars append or replace only their flag and preserve unrelated bytes', () => {
  assert.equal(fenceVars(privateLine, 'ASSESSMENT-ON'), privateLine + 'synthetic_assessment_enabled = true\n');
  assert.equal(fenceVars(privateLine, 'ASSESSMENT-OFF'), privateLine + 'synthetic_assessment_enabled = false\n');
  assert.equal(fenceVars(privateLine + 'synthetic_assessment_enabled = false\n', 'ASSESSMENT-ON'), privateLine + 'synthetic_assessment_enabled = true\n');
  assert.equal(fenceVars(privateLine + 'synthetic_assessment_enabled = true # approved\n', 'ASSESSMENT-OFF'), privateLine + 'synthetic_assessment_enabled = false\n');
  assert.equal(fenceVars('x = 1', 'ASSESSMENT-ON'), 'x = 1\nsynthetic_assessment_enabled = true\n', 'a file without a final newline gets one before the flag');
});
test('the medication flag and the assessment flag never touch each other\'s line', () => {
  const both = privateLine + 'medication_writes_enabled = false\nsynthetic_assessment_enabled = false\n';
  assert.equal(fenceVars(both, 'ASSESSMENT-ON'), privateLine + 'medication_writes_enabled = false\nsynthetic_assessment_enabled = true\n');
  assert.equal(fenceVars(both, 'FENCE-OPEN'), privateLine + 'medication_writes_enabled = true\nsynthetic_assessment_enabled = false\n');
  assert.equal(fenceVars(privateLine + 'medication_writes_enabled = true\n', 'ASSESSMENT-ON'), privateLine + 'medication_writes_enabled = true\nsynthetic_assessment_enabled = true\n');
  assert.equal(fenceVars(privateLine + 'synthetic_assessment_enabled = true\n', 'FENCE-CLOSE'), privateLine + 'synthetic_assessment_enabled = true\nmedication_writes_enabled = false\n');
});
test('ambiguous HCL and duplicates are rejected for the assessment flag without values', () => {
  for (const text of ['synthetic_assessment_enabled = 1', 'synthetic_assessment_enabled = var.x', 'synthetic_assessment_enabled = false\nsynthetic_assessment_enabled = true',
    '/*\nsynthetic_assessment_enabled = false\n*/', 'synthetic_assessment_enabled = false\r\n', 'note = <<EOF\nsynthetic_assessment_enabled = false\nEOF',
    'synthetic_assessment_enabled = "true"']) {
    assert.throws(() => fenceVars(text, 'ASSESSMENT-ON'));
  }
  assert.throws(() => fenceVars(privateLine, 'ASSESSMENT'));
  assert.throws(() => fenceVars(privateLine, 'ASSESSMENT-ENABLE'));
});
test('assessment plan records bind both the canonical source and the generated target var files', () => {
  for (const mode of ['ASSESSMENT-ON', 'ASSESSMENT-OFF']) {
    const input = { mode, head: 'a'.repeat(40), varSha256: 'b'.repeat(64), planSha256: 'c'.repeat(64), sourceVarSha256: 'd'.repeat(64), state: { serial: 7, lineage: 'synthetic' } };
    const saved = record(input);
    assert.equal(saved.sourceVarSha256, 'd'.repeat(64));
    assert.deepEqual(mismatches(saved, record(input)), []);
    assert.match(mismatches(saved, record({ ...input, sourceVarSha256: 'e'.repeat(64) }))[0], /sourceVarSha256/);
    assert.throws(() => record({ ...input, sourceVarSha256: undefined }));
  }
  assert.doesNotThrow(() => record({ mode: 'IMAGE', head: 'a'.repeat(40), varSha256: 'b'.repeat(64), planSha256: 'c'.repeat(64), state: { serial: 7, lineage: 'synthetic' } }), 'the other modes still need no source hash');
});

// Switching the assessment on (spec 032 S3, PR 3c-3b): a signature, or a break-glass record with a written reason. The medication fence stays signature-only.
const ASSESSMENT_IMAGE = '111122223333.dkr.ecr.us-east-2.amazonaws.com/telesphoros-staging-api@sha256:' + 'a'.repeat(64);
const OTHER_IMAGE = ASSESSMENT_IMAGE.replace(/a{64}$/, 'b'.repeat(64));
const SIGNED = { format: 1, environment: 'staging', method: 'signature', images: [ASSESSMENT_IMAGE], keyAlias: 'alias/telesphoros-staging-image-signing',
  keyArn: 'arn:aws:kms:us-east-2:111122223333:key/11111111-2222-4333-8444-555555555555', cosignVersion: 'v3.1.3', recordedAt: '2026-11-04T00:00:00Z' };
const BREAK_GLASS = { format: 1, environment: 'staging', images: [ASSESSMENT_IMAGE], recordedAt: '2026-11-04T00:00:00Z', method: 'break-glass',
  reason: 'CI release-image cannot sign in this account; founder approved an unsigned synthetic staging image' };

test('the assessment accepts a signature record as before, and a break-glass record that names the image and gives a reason', () => {
  assert.equal(coversAssessmentImage(SIGNED, ASSESSMENT_IMAGE), true);
  assert.equal(coversAssessmentImage(BREAK_GLASS, ASSESSMENT_IMAGE), true);
});
test('the medication fence still refuses a break-glass record', () => {
  assert.equal(coversFenceImage(BREAK_GLASS, ASSESSMENT_IMAGE), false);
});
test('the assessment refuses a break-glass record that is weaker than that, and every signature refusal still holds', () => {
  for (const change of [{ reason: undefined }, { reason: '' }, { reason: 'too short' }, { reason: '                ' }, { reason: 'x'.repeat(301) }, { reason: 'two lines\nof reasoning here' },
    { reason: 42 }, { method: 'unsigned' }, { method: undefined }, { environment: 'production' }, { environment: undefined }, { format: 2 }, { format: undefined },
    { images: [] }, { images: undefined }, { images: [OTHER_IMAGE] }, { images: [ASSESSMENT_IMAGE, OTHER_IMAGE] }, { recordedAt: 'not a date' }, { recordedAt: undefined }]) {
    assert.equal(coversAssessmentImage({ ...BREAK_GLASS, ...change }, ASSESSMENT_IMAGE), false, `a break-glass record with ${Object.keys(change)[0]} changed must be refused`);
  }
  assert.equal(coversAssessmentImage(BREAK_GLASS, OTHER_IMAGE), false, 'a record for another image');
  assert.equal(coversAssessmentImage(BREAK_GLASS, 'not-an-image'), false);
  // A record and an image that agree with each other are still refused unless the image is a staging API digest: only that check does this work.
  for (const odd of [ASSESSMENT_IMAGE.replace('us-east-2', 'us-east-1'), ASSESSMENT_IMAGE.replace('telesphoros-staging-api', 'telesphoros-other'), ASSESSMENT_IMAGE.replace(/@sha256:.*$/, ':latest'),
    ASSESSMENT_IMAGE.replace('111122223333', '1111')]) {
    assert.equal(coversAssessmentImage({ ...BREAK_GLASS, images: [odd] }, odd), false, `an agreeing record for ${odd.slice(0, 40)} must be refused`);
  }
  assert.equal(coversAssessmentImage(BREAK_GLASS, undefined), false);
  for (const record of [null, undefined, {}, []]) assert.equal(coversAssessmentImage(record, ASSESSMENT_IMAGE), false);
  for (const change of [{ environment: 'production' }, { method: 'unsigned' }, { keyAlias: 'alias/other' }, { images: [OTHER_IMAGE] }, { cosignVersion: 'v2.0.0' }]) {
    assert.equal(coversAssessmentImage({ ...SIGNED, ...change }, ASSESSMENT_IMAGE), false);
  }
});
test('the command line takes a break-glass record only with --allow-break-glass, and its refusals print nothing from the record', () => {
  const dir = mkdtempSync(join(tmpdir(), 'image-record-'));
  const script = new URL('./fence-image-record.mjs', import.meta.url).pathname;
  const run = (...args) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
  try {
    const breakGlass = join(dir, 'break-glass.json'); writeFileSync(breakGlass, JSON.stringify({ ...BREAK_GLASS, reason: 'SYN-PRIVATE reason that is long enough to be valid' }));
    const signed = join(dir, 'signed.json'); writeFileSync(signed, JSON.stringify(SIGNED));
    const garbage = join(dir, 'garbage.json'); writeFileSync(garbage, 'SYN-PRIVATE not json');
    assert.equal(run(signed, ASSESSMENT_IMAGE).status, 0);
    assert.equal(run(signed, ASSESSMENT_IMAGE, '--allow-break-glass').status, 0);
    assert.equal(run(breakGlass, ASSESSMENT_IMAGE, '--allow-break-glass').status, 0);
    const strict = run(breakGlass, ASSESSMENT_IMAGE);
    assert.equal(strict.status, 1);
    assert.match(strict.stderr, /signature-verification record/);
    for (const result of [strict, run(garbage, ASSESSMENT_IMAGE, '--allow-break-glass'), run(garbage, ASSESSMENT_IMAGE), run(breakGlass, OTHER_IMAGE, '--allow-break-glass'),
      run(breakGlass, ASSESSMENT_IMAGE, '--something-else'), run(breakGlass, ASSESSMENT_IMAGE, '--allow-break-glass', 'extra'), run(join(dir, 'missing.json'), ASSESSMENT_IMAGE, '--allow-break-glass')]) {
      assert.equal(result.status, 1);
      assert.ok(!result.stderr.includes('SYN-PRIVATE') && !result.stdout.includes('SYN-PRIVATE'), 'a refusal never prints record content');
    }
    assert.match(run(garbage, ASSESSMENT_IMAGE, '--allow-break-glass').stderr, /break-glass record with a written reason/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
