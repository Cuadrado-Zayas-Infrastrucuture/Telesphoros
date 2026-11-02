// Read-only action check for the plans of a release onto running synthetic staging (spec 027, PR 3a). Replaces the per-release copies in
// ~/telesphoros-private/release-*/: each of those was edited to expect that release's other changes, which is how merged Terraform rode along
// (#195, #198, #210). Here the shapes are fixed, and anything beyond them is refused: merged Terraform goes out first, as its own INFRA plan.
//   MIGRATE  api_migrate_image = NEW, api_image = OLD: only the migration task definition is replaced, on NEW. Nothing else changes.
//   IMAGE    both images NEW: the API, provisioning and worker task definitions are replaced on NEW, and the two services move to them.
//   INFRA    both images OLD (the canonical var file unchanged): no task definition or service changes; never a protected type destroyed or
//            replaced. Everything else in the plan is for the founder's line-by-line read, which this check does not replace.
//   FENCE-CLOSE / FENCE-OPEN keep one image, replace only the API task definition and move its service, changing only MEDICATION_WRITES.
// Usage: node release-check.mjs MIGRATE|IMAGE|INFRA plan.json OLD_IMAGE NEW_IMAGE   (INFRA: NEW_IMAGE = OLD_IMAGE). Prints addresses, never values.
import { fenceProblems } from './fence-plan.mjs';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const canonical = (v) => JSON.stringify(v, (_, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b))) : x));
const IMAGE_RE = /^[0-9]{12}\.dkr\.ecr\.us-east-2\.amazonaws\.com\/telesphoros-staging-api@sha256:[0-9a-f]{64}$/;
const REPLACE = [canonical(['delete', 'create']), canonical(['create', 'delete'])];
const TD = (n) => `aws_ecs_task_definition.${n}[0]`;
const SVC = (n) => `aws_ecs_service.${n}[0]`;
const RELEASE_TYPES = ['aws_ecs_task_definition', 'aws_ecs_service'];
/** What no release plan may destroy or replace: the data, its keys, and every account. */
export const PROTECTED_TYPES = ['aws_db_instance', 'aws_s3_bucket', 'aws_kms_key', 'aws_cognito_user_pool', 'aws_secretsmanager_secret', 'aws_cloudtrail'];

const SHAPES = {
  MIGRATE: { vars: (o, n) => ({ api_image: o, api_migrate_image: n }), replace: { [TD('api_migrate')]: 'NEW' }, update: [] },
  IMAGE: { vars: (_o, n) => ({ api_image: n, api_migrate_image: n }), replace: { [TD('api')]: 'NEW', [TD('api_provision')]: 'NEW', [TD('worker')]: 'NEW' }, update: [SVC('api'), SVC('worker')] },
  INFRA: { vars: (o) => ({ api_image: o, api_migrate_image: o }), replace: {}, update: [], open: true },
};

// Drift AWS or the provider makes on its own, seen on this stack and reviewed: RDS's restore mark, Cognito's user counter, a null read back
// as empty (also nested, and for CloudFront as an empty list), and the alarm subscription confirmed (true -> false only).
const SELF_MOVING = { aws_db_instance: ['latest_restorable_time'], aws_cognito_user_pool: ['estimated_number_of_users'] };
const nullToEmpty = (b, a) => b === null && (canonical(a) === '[]' || canonical(a) === '{}');
const normalised = (emptyList) => function norm(v) {
  if (v === null || (emptyList && Array.isArray(v) && v.length === 0) || (v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0)) return null;
  if (Array.isArray(v)) return v.map(norm);
  return v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, norm(x)])) : v;
};
const deepNullOnly = (b, a, emptyList = false) => canonical(b) !== canonical(a) && canonical(normalised(emptyList)(b)) === canonical(normalised(emptyList)(a));
const confirmed = (type, k, b, a) => type === 'aws_sns_topic_subscription' && k === 'pending_confirmation' && b === true && a === false;
const harmlessDrift = (d) => {
  const { actions, before, after } = d.change ?? {};
  if (d.mode !== 'managed' || canonical(actions) !== canonical(['update']) || !before || !after) return false;
  const moved = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((k) => canonical(before[k]) !== canonical(after[k]));
  return moved.length > 0 && moved.every((k) => (SELF_MOVING[d.type] ?? []).includes(k) || nullToEmpty(before[k], after[k]) || confirmed(d.type, k, before[k], after[k])
    || (d.type === 'aws_cloudwatch_log_metric_filter' && k === 'metric_transformation' && deepNullOnly(before[k], after[k]))
    || (d.type === 'aws_cloudfront_distribution' && k === 'ordered_cache_behavior' && deepNullOnly(before[k], after[k], true)));
};
const containers = (change) => {
  try {
    const raw = change?.after?.container_definitions;
    return typeof raw === 'string' ? JSON.parse(raw) : Array.isArray(raw) ? raw : null;
  } catch {
    return null;
  }
};

/** Each reason the plan is not a MIGRATE, IMAGE or INFRA plan of this release; empty when it is. */
export function problems(mode, plan, oldImage, newImage) {
  if (mode === 'FENCE-CLOSE' || mode === 'FENCE-OPEN') return fenceProblems(mode, plan, oldImage, newImage);
  const out = [];
  const need = (ok, why) => { if (!ok) out.push(why); };
  const shape = SHAPES[mode];
  if (!shape) return ['mode must be MIGRATE, IMAGE, INFRA, FENCE-CLOSE or FENCE-OPEN'];
  if (!IMAGE_RE.test(oldImage ?? '') || !IMAGE_RE.test(newImage ?? '')) return ['OLD and NEW must be digest-pinned staging API images'];
  if (mode !== 'INFRA' && oldImage === newImage) return ['a MIGRATE or IMAGE plan needs two different images'];
  if (!plan || !/^1\./.test(plan.format_version ?? '') || !Array.isArray(plan.resource_changes)) return ['expected terraform show -json plan output with resource_changes'];
  need(plan.errored !== true && plan.complete === true && plan.applyable === true, 'plan must be complete, applicable and free of errors (no -target)');
  const v = (k) => plan.variables?.[k]?.value;
  need(v('deployment_profile') === 'synthetic' && v('environment') === 'staging' && v('region') === 'us-east-2', 'only the us-east-2 staging/synthetic profile');
  for (const [k, want] of Object.entries(shape.vars(oldImage, newImage))) need(v(k) === want, `${k} must be the ${want === newImage && mode !== 'INFRA' ? 'NEW' : 'OLD'} image`);
  for (const d of plan.resource_drift ?? []) if (canonical(d.change?.actions) !== canonical(['no-op']) && !harmlessDrift(d)) out.push(`${d.address}: drift needs review`);

  const changes = plan.resource_changes.filter((c) => !['["no-op"]', '["read"]'].includes(canonical(c.change?.actions)));
  const seen = new Set();
  for (const c of changes) {
    const a = canonical(c.change?.actions);
    seen.add(c.address);
    if (c.mode !== 'managed' || c.deposed || c.change?.importing) { out.push(`${c.address}: deposed, imported or not managed`); continue; }
    if (PROTECTED_TYPES.includes(c.type) && (a === canonical(['delete']) || REPLACE.includes(a))) { out.push(`${c.address}: a protected resource would be destroyed`); continue; }
    if (c.address in shape.replace) {
      need(REPLACE.includes(a), `${c.address}: expected a replacement, got ${c.change.actions.join(',')}`);
      const list = containers(c.change);
      need(list !== null && list.length >= 1 && list.every((k) => k.image === newImage), `${c.address}: every container must run the NEW image`);
      continue;
    }
    if (shape.update.includes(c.address)) {
      need(a === canonical(['update']), `${c.address}: expected an in-place update, got ${c.change.actions.join(',')}`);
      const { before, after, after_unknown: unknown } = c.change;
      const moved = [...new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])].filter((k) => canonical(before?.[k]) !== canonical(after?.[k]) || unknown?.[k] === true);
      need(moved.length > 0 && moved.every((k) => k === 'task_definition'), `${c.address}: only task_definition may change (moved: ${moved.join(', ') || 'nothing'})`);
      continue;
    }
    if (shape.open && !RELEASE_TYPES.includes(c.type)) continue;
    out.push(`${c.address}: unexpected ${c.change?.actions?.join(',')}${shape.open ? ' (an INFRA plan never moves a task definition or a service)' : ' (merged Terraform goes out first, as its own INFRA plan)'}`);
  }
  for (const addr of [...Object.keys(shape.replace), ...shape.update]) need(seen.has(addr), `${addr}: expected in this ${mode} plan, missing`);
  if (shape.open) need(changes.length > 0, 'an INFRA plan with nothing to do: there is nothing to apply');
  const outputs = Object.entries(plan.output_changes ?? {}).filter(([, o]) => canonical(o.actions) !== canonical(['no-op']));
  if (!shape.open) for (const [name] of outputs) out.push(`output ${name}: unexpected change`);
  return out;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [mode, file, oldImage, newImage] = process.argv.slice(2);
  if (!newImage) { console.error('usage: node release-check.mjs MIGRATE|IMAGE|INFRA plan.json OLD_IMAGE NEW_IMAGE'); process.exit(2); }
  let plan;
  try { plan = JSON.parse(readFileSync(file, 'utf8')); } catch { console.error('REFUSED: plan could not be read as JSON'); process.exit(1); }
  const found = problems(mode, plan, oldImage, newImage);
  if (found.length) { for (const p of found) console.error(`REFUSED: ${p}`); process.exit(1); }
  console.log(`release-check ${mode} passed: only the expected changes. A line-by-line read of the plan text is still required.`);
}
