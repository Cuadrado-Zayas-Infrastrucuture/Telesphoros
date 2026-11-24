// Tests for scripts/staging/release/clinical-review.mjs (spec 048). Imported by infrastructure/terraform/guard.test.mjs (`pnpm test:infra`).
// Each test builds a throwaway git history and P-256 keys made here, so no real key, image or release is touched.
// What this cannot prove: that KMS keeps returning DER signatures and base64 SPKI public keys as documented for ECC_NIST_P256 and
// ECDSA_SHA_256 (the same assumption `knowledge:sign` makes), or that the founder runs the step.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { generateKeyPairSync, sign } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';
import {
  CLINICAL_PATHS,
  REVIEWER_KEY_ID,
  changedClinicalFiles,
  checkGate,
  exceptionRecord,
  reviewMessage,
  reviewRecord,
  validReason,
} from './clinical-review.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOTS = [];
after(() => ROOTS.forEach((root) => rmSync(root, { recursive: true, force: true })));

const DIGEST_A = `sha256:${'a'.repeat(64)}`;
const DIGEST_B = `sha256:${'b'.repeat(64)}`;
const running = (digest) => `123456789012.dkr.ecr.us-east-2.amazonaws.com/telesphoros-staging-api@${digest}`;

function git(repo, ...args) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/** A history: base (released), then the candidate, which changes `files` (path -> content). The note at the candidate names the base. */
function history(files, { noteDigest = DIGEST_A, noteBase } = {}) {
  const repo = mkdtempSync(join(tmpdir(), 'clinical-review-'));
  ROOTS.push(repo);
  git(repo, 'init', '-q');
  git(repo, 'config', 'user.email', 'test@example.invalid');
  git(repo, 'config', 'user.name', 'test');
  const put = (path, text) => {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), text);
  };
  put('apps/backend/src/services/recommendation-engine/rule.ts', 'export const r = 1;\n');
  put('apps/frontend/src/page.tsx', 'export const p = 1;\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'base');
  const base = git(repo, 'rev-parse', 'HEAD');
  for (const [path, text] of Object.entries(files)) put(path, text);
  put('docs/ops/staging-expected.json', `${JSON.stringify({ image: { digest: noteDigest, commit: noteBase ?? base } }, null, 2)}\n`);
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'candidate');
  return { repo, base, candidate: git(repo, 'rev-parse', 'HEAD') };
}

const keys = () => generateKeyPairSync('ec', { namedCurve: 'P-256' });
const kmsPublicKey = (publicKey) => publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
const kmsSign = (privateKey, bytes) => sign('sha256', bytes, { key: privateKey, dsaEncoding: 'der' }).toString('base64');
const note = (repo) => readFileSync(join(repo, 'docs/ops/staging-expected.json'), 'utf8');

function gate(h, { record, reviewer, environment = 'staging', image = running(DIGEST_A) } = {}) {
  return checkGate({ repo: h.repo, candidate: h.candidate, noteText: note(h.repo), runningImage: image, record, reviewerKey: reviewer, environment });
}

const CLINICAL_CHANGE = { 'apps/backend/src/services/recommendation-engine/rule.ts': 'export const r = 2;\n' };

test('T-1: only non-clinical files changed passes as "no clinical change", with no record needed', () => {
  const h = history({ 'apps/frontend/src/page.tsx': 'export const p = 2;\n' });
  const result = gate(h);
  assert.deepEqual(result.problems, []);
  assert.equal(result.kind, 'no-clinical-change');
  assert.deepEqual(result.changed, []);
  assert.equal(result.base, h.base);
});

test('T-2: a clinical change with no record is refused', () => {
  const h = history(CLINICAL_CHANGE);
  const result = gate(h);
  assert.equal(result.kind, 'refused');
  assert.match(result.problems.join('\n'), /needs a clinical review record/);
  assert.deepEqual(result.changed, ['apps/backend/src/services/recommendation-engine/rule.ts']);
});

test('T-3: a record signed by the reviewer key over this base and candidate, with the computed list, passes', () => {
  const h = history(CLINICAL_CHANGE);
  const kevin = keys();
  const changed = changedClinicalFiles(h.repo, h.base, h.candidate);
  const record = reviewRecord({ base: h.base, candidate: h.candidate, changed, signature: kmsSign(kevin.privateKey, reviewMessage(h.base, h.candidate)) });
  const result = gate(h, { record, reviewer: kmsPublicKey(kevin.publicKey) });
  assert.deepEqual(result.problems, []);
  assert.equal(result.kind, 'review');
  assert.equal(record.review.keyId, REVIEWER_KEY_ID);
});

test("T-4: a record signed by another key (the founder's) is refused", () => {
  const h = history(CLINICAL_CHANGE);
  const [kevin, jan] = [keys(), keys()];
  const changed = changedClinicalFiles(h.repo, h.base, h.candidate);
  const record = reviewRecord({ base: h.base, candidate: h.candidate, changed, signature: kmsSign(jan.privateKey, reviewMessage(h.base, h.candidate)) });
  const result = gate(h, { record, reviewer: kmsPublicKey(kevin.publicKey) });
  assert.equal(result.kind, 'refused');
  assert.match(result.problems.join('\n'), /does not verify against the reviewer key/);
  // A record that names another key id is refused before any signature is checked.
  const named = { ...record, review: { ...record.review, keyId: 'jan' } };
  assert.match(gate(h, { record: named, reviewer: kmsPublicKey(kevin.publicKey) }).problems.join('\n'), /key id must be "kevin"/);
});

test('T-5: a record for another base or candidate, or with an edited file list, is refused', () => {
  const h = history(CLINICAL_CHANGE);
  const kevin = keys();
  const reviewer = kmsPublicKey(kevin.publicKey);
  const changed = changedClinicalFiles(h.repo, h.base, h.candidate);
  const signed = (base, candidate, list) => reviewRecord({ base, candidate, changed: list, signature: kmsSign(kevin.privateKey, reviewMessage(base, candidate)) });
  const other = 'c'.repeat(40);
  assert.match(gate(h, { record: signed(other, h.candidate, changed), reviewer }).problems.join('\n'), /base/);
  assert.match(gate(h, { record: signed(h.base, other, changed), reviewer }).problems.join('\n'), /candidate/);
  assert.match(gate(h, { record: signed(h.base, h.candidate, []), reviewer }).problems.join('\n'), /changed clinical files/);
  // A valid signature does not carry over to an edited list: the list is compared, not signed.
  const edited = { ...signed(h.base, h.candidate, changed), changed: [...changed, 'knowledge/x.json'] };
  assert.match(gate(h, { record: edited, reviewer }).problems.join('\n'), /changed clinical files/);
});

test('T-6: a signature over the knowledge tag, or over the same lines with another tag, is refused', () => {
  const h = history(CLINICAL_CHANGE);
  const kevin = keys();
  const reviewer = kmsPublicKey(kevin.publicKey);
  const changed = changedClinicalFiles(h.repo, h.base, h.candidate);
  const asKnowledge = Buffer.from(`telesphoros-knowledge/1\n${h.base}\n${h.candidate}`, 'utf8');
  const asOther = Buffer.from(`telesphoros-clinical-review/2\n${h.base}\n${h.candidate}`, 'utf8');
  for (const bytes of [asKnowledge, asOther]) {
    const record = reviewRecord({ base: h.base, candidate: h.candidate, changed, signature: kmsSign(kevin.privateKey, bytes) });
    assert.match(gate(h, { record, reviewer }).problems.join('\n'), /does not verify/);
  }
  assert.equal(reviewMessage(h.base, h.candidate).toString('utf8'), `telesphoros-clinical-review/1\n${h.base}\n${h.candidate}`);
});

test('T-7: a note whose digest is not what runs, or whose base is not an ancestor, is refused', () => {
  const h = history({ 'apps/frontend/src/page.tsx': 'export const p = 2;\n' });
  assert.match(gate(h, { image: running(DIGEST_B) }).problems.join('\n'), /not the image ECS is running/);
  const stranger = history({}, { noteBase: 'd'.repeat(40) });
  assert.match(gate(stranger).problems.join('\n'), /not an ancestor/);
  assert.match(checkGate({ repo: h.repo, candidate: h.candidate, noteText: '{', runningImage: running(DIGEST_A), environment: 'staging' }).problems.join('\n'), /staging-expected\.json/);
});

test('T-8: an exception with a valid reason passes on staging, says so, and is refused on production or with a bad reason', () => {
  const h = history(CLINICAL_CHANGE);
  const changed = changedClinicalFiles(h.repo, h.base, h.candidate);
  const record = exceptionRecord({ base: h.base, candidate: h.candidate, changed, reason: 'Kevin has no signing key yet; synthetic staging only' });
  const staging = gate(h, { record });
  assert.deepEqual(staging.problems, []);
  assert.equal(staging.kind, 'exception');
  assert.match(gate(h, { record, environment: 'production' }).problems.join('\n'), /no exception in production/);
  for (const reason of ['too short', 'x'.repeat(301), 'two\nlines here']) {
    assert.equal(validReason(reason), false, reason);
    assert.match(gate(h, { record: { ...record, exception: { reason } } }).problems.join('\n'), /reason/);
  }
  assert.match(gate(h, { record, environment: 'test' }).problems.join('\n'), /environment/);
});

test('T-9: a review record when the reviewer key is missing is refused, naming the key', () => {
  const h = history(CLINICAL_CHANGE);
  const kevin = keys();
  const changed = changedClinicalFiles(h.repo, h.base, h.candidate);
  const record = reviewRecord({ base: h.base, candidate: h.candidate, changed, signature: kmsSign(kevin.privateKey, reviewMessage(h.base, h.candidate)) });
  assert.match(gate(h, { record }).problems.join('\n'), /alias\/telesphoros-staging-knowledge-signer-kevin/);
  assert.match(gate(h, { record, reviewer: 'not base64 DER' }).problems.join('\n'), /reviewer key/);
});

test('T-11: a change in the genomic profile or the gene modifier lists counts as clinical (specs 044 and 045 live outside services/)', () => {
  for (const path of ['apps/backend/src/genomic-profile/genomic-profile.builder.ts', 'apps/backend/src/gene-modifiers/gene-modifier-set.ts']) {
    const h = history({ [path]: 'export const changed = true;\n' });
    const result = gate(h);
    assert.equal(result.kind, 'refused', path);
    assert.deepEqual(result.changed, [path]);
  }
});

test("T-10: the clinical paths equal CODEOWNERS' clinical block", () => {
  const owners = readFileSync(join(HERE, '../../../.github/CODEOWNERS'), 'utf8').split('\n');
  const start = owners.findIndex((line) => line.startsWith('# Clinical content and logic'));
  assert.notEqual(start, -1, 'CODEOWNERS has no "Clinical content and logic" block');
  const block = [];
  for (const line of owners.slice(start + 1)) {
    if (line.trim() === '' || line.startsWith('#')) break;
    block.push(line.split(/\s+/)[0].replace(/^\//, ''));
  }
  assert.deepEqual([...CLINICAL_PATHS].sort(), block.sort());
});

test('the command: gate writes the no-change record and exits 0; a clinical change without a record exits 1; message prints the bytes', () => {
  const script = join(HERE, 'clinical-review.mjs');
  const run = (args) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
  const quiet = history({ 'apps/frontend/src/page.tsx': 'export const p = 2;\n' });
  const out = mkdtempSync(join(tmpdir(), 'clinical-review-out-'));
  ROOTS.push(out);
  const ok = run(['gate', quiet.repo, quiet.candidate, running(DIGEST_A), out]);
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(JSON.parse(readFileSync(join(out, 'clinical-review.json'), 'utf8')).noClinicalChange, true);
  const changed = history(CLINICAL_CHANGE);
  const out2 = mkdtempSync(join(tmpdir(), 'clinical-review-out-'));
  ROOTS.push(out2);
  const refused = run(['gate', changed.repo, changed.candidate, running(DIGEST_A), out2]);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /needs a clinical review record/);
  const message = run(['message', changed.base, changed.candidate]);
  assert.equal(message.status, 0);
  assert.equal(message.stdout, reviewMessage(changed.base, changed.candidate).toString('utf8'));
});

test('the command reads the reviewer key from KMS only for a review record, and a review record from `record` passes the gate', () => {
  const script = join(HERE, 'clinical-review.mjs');
  const h = history(CLINICAL_CHANGE);
  const kevin = keys();
  const bin = mkdtempSync(join(tmpdir(), 'clinical-review-bin-'));
  const out = mkdtempSync(join(tmpdir(), 'clinical-review-out-'));
  ROOTS.push(bin, out);
  const awsLog = join(bin, 'aws.log');
  writeFileSync(join(bin, 'aws'), `#!/bin/sh\necho "$*" >> "${awsLog}"\ncase "$*" in *"get-public-key --key-id alias/telesphoros-staging-knowledge-signer-kevin "*) echo "${kmsPublicKey(kevin.publicKey)}" ;; *) exit 99 ;; esac\n`, { mode: 0o755 });
  const run = (args) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
  const made = run(['record', h.repo, h.base, h.candidate, kmsSign(kevin.privateKey, reviewMessage(h.base, h.candidate))]);
  assert.equal(made.status, 0, made.stderr);
  writeFileSync(join(out, 'clinical-review.json'), made.stdout);
  const passed = run(['gate', h.repo, h.candidate, running(DIGEST_A), out]);
  assert.equal(passed.status, 0, passed.stderr);
  assert.match(passed.stdout, /reviewed by kevin/);
  assert.match(readFileSync(awsLog, 'utf8'), /kms get-public-key --key-id alias\/telesphoros-staging-knowledge-signer-kevin/);
  // An exception record never asks KMS.
  rmSync(awsLog);
  writeFileSync(join(out, 'clinical-review.json'), run(['exception', h.repo, h.base, h.candidate, 'no reviewer key yet; synthetic staging']).stdout);
  const excepted = run(['gate', h.repo, h.candidate, running(DIGEST_A), out]);
  assert.equal(excepted.status, 0, excepted.stderr);
  assert.match(excepted.stdout, /EXCEPTION/);
  assert.equal(existsSync(awsLog), false);
  assert.equal(run(['gate', h.repo, h.candidate, running(DIGEST_A), out, 'production']).status, 1);
});
