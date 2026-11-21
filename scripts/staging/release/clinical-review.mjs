// Clinical review before a release (spec 048, audit slice P0-B). image.sh calls `gate` after its clone and identity gates and before it
// pushes anything to ECR: a release whose commit changes a clinical path since the image that runs needs Kevin's signed review, or, on
// staging only, a one-line reason from the founder (an exception, recorded as one). The record goes into the release's facts pull request.
// Usage:
//   node clinical-review.mjs gate CLONE COMMIT RUNNING_IMAGE OUT_DIR [ENVIRONMENT]   exit 0 to go on, 1 to stop; ENVIRONMENT is staging
//   node clinical-review.mjs message BASE COMMIT                 the exact bytes Kevin signs (redirect to a file for `aws kms sign`)
//   node clinical-review.mjs record CLONE BASE COMMIT SIGNATURE  a review record, SIGNATURE being `aws kms sign`'s base64 output
//   node clinical-review.mjs exception CLONE BASE COMMIT REASON  an exception record (staging only)
// Prints file paths and outcomes, never a key. Tests: clinical-review.test.mjs.
import { execFileSync } from 'node:child_process';
import { createPublicKey, verify } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isMain } from '../is-main.mjs';

/** RC-1: the "Clinical content and logic" paths of .github/CODEOWNERS, kept equal to them by a test. */
export const CLINICAL_PATHS = Object.freeze(['knowledge/', 'packages/cpic-schema/', 'apps/backend/src/services/', 'tests/clinical_scenarios/', 'docs/clinical-validation/']);
/** D2: the reviewer is the knowledge signer whose key id is `kevin` (spec 033-14 SR-1); no other key approves. */
export const REVIEWER_KEY_ID = 'kevin';
export const REVIEWER_ALIAS = 'alias/telesphoros-staging-knowledge-signer-kevin';
export const SCHEMA = 'clinical-review/1';
const ENVIRONMENTS = ['staging', 'production'];
const SHA = /^[0-9a-f]{40}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;

/** RC-5: what Kevin signs. Its tag is not the knowledge signing tag (`telesphoros-knowledge/1`), so neither signature stands for the other. */
export function reviewMessage(base, candidate) {
  return Buffer.from(`telesphoros-clinical-review/1\n${base}\n${candidate}`, 'utf8');
}

/** RC-6: the exception's reason, as for the unsigned-image reason: one line of 10 to 300 characters. */
export function validReason(text) {
  return typeof text === 'string' && !/[\r\n]/.test(text) && text.trim().length >= 10 && text.length <= 300;
}

/** The clinical files that differ between two commits, sorted; renames count on both sides. */
export function changedClinicalFiles(repo, base, candidate) {
  const out = execFileSync('git', ['-C', repo, 'diff', '--name-only', '--no-renames', '-z', base, candidate, '--', ...CLINICAL_PATHS], { encoding: 'utf8' });
  return out.split('\0').filter(Boolean).sort();
}

export function reviewRecord({ base, candidate, changed, signature }) {
  return { schema: SCHEMA, base, candidate, changed: [...changed], review: { keyId: REVIEWER_KEY_ID, signature } };
}

export function exceptionRecord({ base, candidate, changed, reason }) {
  return { schema: SCHEMA, base, candidate, changed: [...changed], exception: { reason } };
}

function isAncestor(repo, base, candidate) {
  try {
    execFileSync('git', ['-C', repo, 'merge-base', '--is-ancestor', base, candidate], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** RC-2: the base is the commit of the image that runs, read from the note and checked against what ECS runs. */
function baseFrom(noteText, runningImage, repo, candidate) {
  let note;
  try {
    note = JSON.parse(noteText);
  } catch {
    return { problem: 'docs/ops/staging-expected.json is not JSON at this commit' };
  }
  const { digest, commit } = note?.image ?? {};
  if (!DIGEST.test(digest ?? '') || !SHA.test(commit ?? '')) return { problem: 'docs/ops/staging-expected.json has no image.digest and image.commit at this commit' };
  const runningDigest = String(runningImage ?? '').split('@')[1];
  if (runningDigest !== digest) return { problem: `docs/ops/staging-expected.json names image ${digest.slice(7, 19)}, which is not the image ECS is running (${(runningDigest ?? 'none').slice(7, 19)}): update the note first` };
  if (!isAncestor(repo, commit, candidate)) return { problem: `the running image's commit ${commit.slice(0, 8)} is not an ancestor of ${candidate.slice(0, 8)}` };
  return { base: commit };
}

function reviewerKeyFrom(base64) {
  try {
    return createPublicKey({ key: Buffer.from(base64, 'base64'), format: 'der', type: 'spki' });
  } catch {
    return undefined;
  }
}

/**
 * The whole decision, without side effects. `record` is the parsed clinical-review.json, or undefined; `reviewerKey` is the base64 SPKI
 * public key KMS returns for REVIEWER_ALIAS, or undefined when there is none. Returns the kind (`no-clinical-change`, `review`,
 * `exception`, or `refused`), the problems, the changed clinical files and the base.
 */
export function checkGate({ repo, candidate, noteText, runningImage, record, reviewerKey, environment }) {
  const refused = (problems, extra = {}) => ({ kind: 'refused', problems, changed: [], ...extra });
  if (!ENVIRONMENTS.includes(environment)) return refused([`environment must be one of ${ENVIRONMENTS.join(', ')}`]);
  if (!SHA.test(candidate ?? '')) return refused(['the candidate must be a full 40-character commit id']);
  const { base, problem } = baseFrom(noteText, runningImage, repo, candidate);
  if (problem) return refused([problem]);
  const changed = changedClinicalFiles(repo, base, candidate);
  if (changed.length === 0 && (record === undefined || record.noClinicalChange === true)) return { kind: 'no-clinical-change', problems: [], changed, base };
  const at = { changed, base };
  if (record === undefined) return refused([`${changed.length} clinical file(s) changed since ${base.slice(0, 8)}: the release needs a clinical review record (clinical-review.json)`], at);
  const problems = [];
  if (record.schema !== SCHEMA) problems.push(`the record's schema must be ${SCHEMA}`);
  if (record.base !== base) problems.push(`the record's base is not ${base.slice(0, 8)}, the commit of the running image`);
  if (record.candidate !== candidate) problems.push(`the record's candidate is not ${candidate.slice(0, 8)}`);
  if (JSON.stringify(record.changed) !== JSON.stringify(changed)) problems.push('the record\'s changed clinical files are not the ones that changed');
  const hasReview = record.review !== undefined;
  const hasException = record.exception !== undefined;
  if (hasReview === hasException) problems.push('the record must hold a review or an exception, not both or neither');
  if (hasException) {
    if (environment !== 'staging') problems.push('there is no exception in production: the release needs the review');
    if (!validReason(record.exception?.reason)) problems.push('the exception reason must be one line of 10 to 300 characters');
  }
  if (hasReview) {
    if (record.review.keyId !== REVIEWER_KEY_ID) problems.push(`the review's key id must be "${REVIEWER_KEY_ID}"`);
    else if (reviewerKey === undefined) problems.push(`no reviewer key: KMS has no ${REVIEWER_ALIAS} (name the signers, then apply), or use the exception on staging`);
    else {
      const key = reviewerKeyFrom(reviewerKey);
      if (!key) problems.push('the reviewer key is not a base64 SPKI public key');
      else {
        let ok = false;
        try {
          ok = verify('sha256', reviewMessage(base, candidate), key, Buffer.from(String(record.review.signature ?? ''), 'base64'));
        } catch {
          ok = false;
        }
        if (!ok) problems.push(`the review's signature does not verify against the reviewer key for ${base.slice(0, 8)}..${candidate.slice(0, 8)}`);
      }
    }
  }
  if (problems.length > 0) return refused(problems, at);
  return { kind: hasReview ? 'review' : 'exception', problems: [], changed, base };
}

function readNote(clone) {
  const path = join(clone, 'docs/ops/staging-expected.json');
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

/** The reviewer's public key from KMS, only when a review must be checked; undefined when the alias does not exist. */
function fetchReviewerKey() {
  try {
    return execFileSync('aws', ['kms', 'get-public-key', '--key-id', REVIEWER_ALIAS, '--region', 'us-east-2', '--query', 'PublicKey', '--output', 'text'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim() || undefined;
  } catch {
    return undefined;
  }
}

function gateCommand([clone, candidate, runningImage, outDir, environment = 'staging']) {
  const path = join(outDir ?? '', 'clinical-review.json');
  let record;
  if (existsSync(path)) {
    try {
      record = JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      console.error(`clinical review: ${path} is not JSON`);
      return 1;
    }
  }
  const reviewerKey = record?.review !== undefined ? fetchReviewerKey() : undefined;
  const result = checkGate({ repo: clone, candidate, noteText: readNote(clone), runningImage, record, reviewerKey, environment });
  if (result.kind === 'refused') {
    for (const problem of result.problems) console.error(`clinical review: ${problem}`);
    for (const file of result.changed) console.error(`  changed: ${file}`);
    return 1;
  }
  if (result.kind === 'no-clinical-change' && record === undefined) {
    writeFileSync(path, `${JSON.stringify({ schema: SCHEMA, base: result.base, candidate, changed: [], noClinicalChange: true }, null, 2)}\n`);
  }
  const what = { 'no-clinical-change': 'no clinical change', review: `reviewed by ${REVIEWER_KEY_ID}`, exception: 'EXCEPTION, without the review (staging only)' }[result.kind];
  console.log(`clinical review: ${what} since ${result.base.slice(0, 8)} (${result.changed.length} clinical file(s)); record ${path}`);
  return 0;
}

function main(argv) {
  const [command, ...rest] = argv;
  if (command === 'gate' && rest.length >= 4) return gateCommand(rest);
  if (command === 'message' && rest.length === 2 && rest.every((s) => SHA.test(s))) {
    process.stdout.write(reviewMessage(rest[0], rest[1]));
    return 0;
  }
  if ((command === 'record' || command === 'exception') && rest.length === 4 && SHA.test(rest[1]) && SHA.test(rest[2])) {
    const [clone, base, candidate, value] = rest;
    const changed = changedClinicalFiles(clone, base, candidate);
    if (command === 'exception' && !validReason(value)) {
      console.error('the exception reason must be one line of 10 to 300 characters');
      return 1;
    }
    const record = command === 'record' ? reviewRecord({ base, candidate, changed, signature: value }) : exceptionRecord({ base, candidate, changed, reason: value });
    process.stdout.write(`${JSON.stringify(record, null, 2)}\n`);
    return 0;
  }
  console.error('usage: clinical-review.mjs gate CLONE COMMIT RUNNING_IMAGE OUT_DIR [staging|production] | message BASE COMMIT | record CLONE BASE COMMIT SIGNATURE | exception CLONE BASE COMMIT REASON');
  return 2;
}

if (isMain(import.meta.url)) process.exit(main(process.argv.slice(2)));
