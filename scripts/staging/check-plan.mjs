// Read-only action check for saved FD-7 A/B/C plans. This does not approve a plan or inspect every resource setting.
// Stage C also needs verified-image.json next to the plan, written by verify-image.mjs (INF-03 slice 3): every image the plan deploys was verified
// against this stack's signing key, or recorded as break-glass for synthetic staging.
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RECORD_FILE, RECORD_FORMAT, signingKeyAlias, validReason } from './verify-image.mjs';

export const IMAGE_POLICY_UPDATES = [
  'aws_iam_role_policy.api_execution_service[0]',
  'aws_iam_role_policy.api_execution_migrate[0]',
  'aws_iam_role_policy.api_execution_provision[0]',
  'aws_iam_role_policy.worker_execution[0]',
];
const PULL_ACTIONS = ['ecr:BatchCheckLayerAvailability', 'ecr:BatchGetImage', 'ecr:GetDownloadUrlForLayer'];
const canonical = (value) => JSON.stringify(value, (_key, item) => item && !Array.isArray(item) && typeof item === 'object'
  ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
const unknown = (value) => value === true || (value && typeof value === 'object' && Object.values(value).some(unknown));
const withoutPolicy = (value) => Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'policy'));

function repositoryOnly(change, repository) {
  if (!change.before || !change.after || unknown(change.after_unknown)) return false;
  if (canonical(withoutPolicy(change.before)) !== canonical(withoutPolicy(change.after))) return false;
  try {
    const before = JSON.parse(change.before.policy);
    const after = JSON.parse(change.after.policy);
    const pull = (policy) => policy.Statement.filter((statement) => statement.Sid === 'PullThisRepositoryOnly');
    const oldPull = pull(before);
    const newPull = pull(after);
    if (oldPull.length !== 1 || newPull.length !== 1) return false;
    const list = (value) => Array.isArray(value) ? value : [value];
    if (oldPull[0].Effect !== 'Allow' || canonical([...list(oldPull[0].Action)].sort()) !== canonical(PULL_ACTIONS)) return false;
    const fallback = repository.replace(/:repository\/.*$/, ':repository/none');
    if (canonical(list(oldPull[0].Resource)) !== canonical([fallback]) || canonical(list(newPull[0].Resource)) !== canonical([repository])) return false;
    // Everything except that one Resource must stay exactly the same, including all other statements and role attributes.
    newPull[0].Resource = oldPull[0].Resource;
    return canonical(before) === canonical(after);
  } catch {
    return false;
  }
}

/** Why the verification record does not cover this plan's images (stage C). Never echoes record contents: only the plan's own values. */
function recordProblems(record, variable, parts) {
  const where = `${RECORD_FILE} (scripts/staging/verify-image.mjs)`;
  if (!record || typeof record !== 'object' || Array.isArray(record)) return [`C needs ${where} next to the saved plan`];
  if (record.format !== RECORD_FORMAT) return [`${RECORD_FILE} is not format ${RECORD_FORMAT}: run verify-image.mjs again`];
  const problems = [];
  const need = (ok, reason) => { if (!ok) problems.push(reason); };
  need(record.environment === variable('environment'), `${RECORD_FILE} is for another environment`);
  const images = Array.isArray(record.images) && record.images.every((image) => typeof image === 'string') ? record.images : null;
  need(images, `${RECORD_FILE} images must be a list of image references`);
  need(images?.includes(variable('api_image')), `api_image ${variable('api_image')} has no verification in ${RECORD_FILE}`);
  const migrate = variable('api_migrate_image');
  if (migrate) need(images?.includes(migrate), `api_migrate_image ${migrate} has no verification in ${RECORD_FILE}`);
  if (record.method === 'signature') {
    const alias = signingKeyAlias(variable('name_prefix'), variable('environment'));
    need(record.keyAlias === alias, `${RECORD_FILE} was not verified with this stack's key ${alias}`);
    const keyArn = parts ? new RegExp(`^arn:aws:kms:${variable('region')}:${parts[1]}:key/[a-z0-9-]+$`) : null;
    need(keyArn?.test(record.keyArn ?? ''), `${RECORD_FILE} key ARN is not a KMS key in this stack's account and Region`);
    need(/^v3\.\d+\.\d+$/.test(record.cosignVersion ?? ''), `${RECORD_FILE} was not made with cosign 3`);
  } else if (record.method === 'break-glass') {
    const production = [variable('environment'), variable('deployment_profile'), record.environment].includes('production');
    need(!production, 'break-glass is never allowed for production (decision D3)');
    need(validReason(record.reason), 'break-glass needs a reason: one line, 10 to 300 characters');
  } else {
    problems.push(`${RECORD_FILE} has an unknown method`);
  }
  return problems;
}

const SES_IDENTITY = 'aws_sesv2_email_identity.from';
const SES_POOL = 'aws_cognito_user_pool.main';
const SES_NOTIFIER_POLICY = 'aws_iam_role_policy.password_notifier';
const REPLACE = [canonical(['delete', 'create']), canonical(['create', 'delete'])];
const withoutEmailSource = (pool) => ({ ...pool, email_configuration: (pool.email_configuration ?? []).map(({ source_arn: _ignored, ...rest }) => rest) });

/**
 * The change after stage A that moves the SES sender from an address identity to its domain (DKIM, so the domain's DMARC policy
 * accepts Cognito's mail). It is applied in TWO targeted plans, because Cognito refuses an SES identity that is not verified yet
 * and the new domain verifies only once its DKIM CNAMEs are in DNS:
 *   1. the identity (replaced by the address's own domain) and the notifier's policy (updated in place);
 *   2. after SES reports the domain verified, the user pool (updated in place; only its SES source ARN changes).
 * A plan may hold any of those changes and nothing else, but never the identity and the pool together. A targeted plan is always
 * `complete: false`, so completeness is not required here: every change in the plan is checked instead. The policy is unknown at
 * plan time because it names the new identity's ARN; guard.test.mjs checks its text.
 */
function sesProblems(plan, need) {
  const problems = [];
  const seen = new Map();
  for (const entry of plan.resource_changes) {
    const { address, mode, change } = entry;
    if (!change || entry.deposed || change.importing) { problems.push(`${address}: incomplete, deposed or imported resource`); continue; }
    const actions = canonical(change.actions);
    if (mode === 'data' && [canonical(['read']), canonical(['no-op'])].includes(actions)) continue;
    if (actions === canonical(['no-op'])) continue;
    seen.set(address, { actions, change });
  }
  for (const address of seen.keys()) {
    if (![SES_IDENTITY, SES_POOL, SES_NOTIFIER_POLICY].includes(address)) problems.push(`${address}: unexpected change; the SES change touches only the identity, the user pool's email source and the notifier policy`);
  }
  need(seen.size > 0, 'the plan changes nothing');
  const identity = seen.get(SES_IDENTITY);
  const pool = seen.get(SES_POOL);
  const policy = seen.get(SES_NOTIFIER_POLICY);
  need(!(identity && pool), `${SES_IDENTITY} and ${SES_POOL} in one plan: apply the identity, wait until SES reports it verified, then plan the user pool on its own (Cognito refuses an unverified identity)`);
  if (identity) {
    const before = identity.change.before?.email_identity;
    const after = identity.change.after?.email_identity;
    need(REPLACE.includes(identity.actions), `${SES_IDENTITY}: must be replaced (address identity to domain identity)`);
    need(typeof before === 'string' && before.split('@').length === 2 && after === before.split('@')[1], `${SES_IDENTITY}: the new identity must be the old address's own domain`);
  }
  if (pool) {
    need(pool.actions === canonical(['update']), `${SES_POOL}: must be updated in place, never replaced (a new pool deletes every account)`);
    if (pool.actions === canonical(['update'])) {
      const { before: old, after: next, after_unknown: unknownAfter } = pool.change;
      const unknownElsewhere = unknownAfter && Object.entries(unknownAfter).some(([key, value]) => key !== 'email_configuration' && unknown(value));
      need(old && next && !unknownElsewhere && canonical(withoutEmailSource(old)) === canonical(withoutEmailSource(next)), `${SES_POOL}: only the email configuration's SES source ARN may change`);
    }
  }
  if (policy) need(policy.actions === canonical(['update']), `${SES_NOTIFIER_POLICY}: expected an in-place update`);
  return problems;
}

export function planProblems(plan, stage, record) {
  const problems = [];
  const need = (ok, reason) => { if (!ok) problems.push(reason); };
  if (!['A', 'B', 'C', 'SES'].includes(stage)) return ['stage must be A, B, C or SES'];
  if (stage === 'SES') {
    if (!plan || !/^1\./.test(plan.format_version ?? '') || !Array.isArray(plan.resource_changes)) return ['expected terraform show -json plan output with resource_changes'];
    // Targeted on purpose (see sesProblems), so `complete` is false; every change is checked instead.
    need(plan.errored !== true && plan.applyable !== false, 'plan must be applicable and free of errors');
    need(plan.variables?.deployment_profile?.value === 'synthetic' && plan.variables?.environment?.value === 'staging', 'only the staging/synthetic profile is supported');
    need(!(plan.resource_drift ?? []).some((entry) => canonical(entry.change?.actions) !== canonical(['no-op'])), 'resource drift requires separate review');
    // sesProblems reports through `need` as well, so it runs before `problems` is read.
    const ses = sesProblems(plan, need);
    return [...problems, ...ses];
  }
  if (!plan || !/^1\./.test(plan.format_version ?? '') || !Array.isArray(plan.resource_changes)) return ['expected terraform show -json plan output with resource_changes'];
  need(plan.errored !== true && plan.complete !== false && plan.applyable !== false, 'plan must be complete, applicable and free of errors');
  const variable = (name) => plan.variables?.[name]?.value;
  // Saved plan JSON retains string values from -var, even when Terraform converts the declared input to bool.
  const bool = (name) => variable(name) === true || variable(name) === 'true' ? true
    : variable(name) === false || variable(name) === 'false' ? false : undefined;
  need(variable('deployment_profile') === 'synthetic' && variable('environment') === 'staging', 'only the staging/synthetic profile is supported');
  need(bool('enable_api_hosting') === true && bool('enable_web_hosting') === (stage !== 'A'), 'hosting switches do not match this stage');
  const image = variable('api_image');
  const parts = typeof image === 'string' && /^([0-9]{12})\.dkr\.ecr\.([a-z0-9-]+)\.amazonaws\.com\/([a-z0-9._/-]+)@sha256:[0-9a-f]{64}$/.exec(image);
  const repository = parts ? `arn:aws:ecr:${parts[2]}:${parts[1]}:repository/${parts[3]}` : null;
  if (stage === 'C') {
    need(parts && parts[2] === variable('region') && parts[3] !== 'none', 'C needs a digest-pinned image in the stack Region');
    problems.push(...recordProblems(record, variable, parts));
  } else need(image === '', 'A and B must have no api_image');
  need(!(plan.resource_drift ?? []).some((entry) => canonical(entry.change?.actions) !== canonical(['no-op'])), 'resource drift requires separate review');
  const seen = new Set();
  const updated = new Set();
  let creates = 0;
  for (const entry of plan.resource_changes) {
    const { address, mode, change } = entry;
    need(typeof address === 'string' && !seen.has(address), 'resource addresses must be present and unique');
    seen.add(address);
    if (!change || entry.deposed || change.importing) { problems.push(`${address}: incomplete, deposed or imported resource`); continue; }
    const actions = canonical(change.actions);
    if (mode === 'data' && [canonical(['read']), canonical(['no-op'])].includes(actions)) continue;
    if (mode !== 'managed') { problems.push(`${address}: unsupported resource mode or data action`); continue; }
    if (actions === canonical(['no-op'])) continue;
    if (actions === canonical(['create']) && change.before === null) { creates++; continue; }
    if (stage === 'C' && actions === canonical(['update']) && IMAGE_POLICY_UPDATES.includes(address) && repository && repositoryOnly(change, repository)) {
      updated.add(address);
      continue;
    }
    problems.push(`${address}: unexpected action or change beyond the image pull repository`);
  }
  need(creates > 0, 'this first-bring-up stage must create resources');
  if (stage === 'C') for (const address of IMAGE_POLICY_UPDATES) need(updated.has(address), `${address}: missing expected first-image policy update`);
  return problems;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 4) throw new Error('usage: node scripts/staging/check-plan.mjs A|B|C|SES plan.json');
    const plan = JSON.parse(readFileSync(process.argv[3], 'utf8'));
    let record;
    if (process.argv[2] === 'C') {
      // Missing or unreadable is the same answer: no record. Its contents are never printed.
      try { record = JSON.parse(readFileSync(join(dirname(resolve(process.argv[3])), RECORD_FILE), 'utf8')); } catch { record = undefined; }
    }
    const problems = planProblems(plan, process.argv[2], record);
    for (const problem of problems) console.error(problem);
    if (problems.length) process.exitCode = 1;
    else {
      if (record?.method === 'break-glass') console.error(`BREAK-GLASS: UNSIGNED IMAGE accepted for stage C (synthetic staging). Reason: ${record.reason}`);
      else if (record) console.log(`Stage C image check: signature verified for ${record.images.length} image(s) with ${record.keyAlias}.`);
      console.log(`Stage ${process.argv[2]} action checks passed; line-by-line resource and cost review is still required.`);
    }
  } catch {
    console.error('Cannot check plan: use A|B|C|SES and a readable terraform show -json plan file.');
    process.exitCode = 1;
  }
}
