import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fenceVars } from './fence-vars.mjs';
import { coversFenceImage } from './fence-image-record.mjs';
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
    { environment: 'production' }, { keyAlias: 'alias/other' }, { keyArn: 'SYN-PRIVATE' }, { cosignVersion: 'v2.0.0' }]) {
    assert.equal(coversFenceImage(Object.keys(change).length ? { ...good, ...change } : {}, image), false);
  }
});
