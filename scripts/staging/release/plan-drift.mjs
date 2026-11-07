// Shared by release-check.mjs (MIGRATE/IMAGE/INFRA) and fence-plan.mjs (FENCE-CLOSE/FENCE-OPEN), so every release mode reads drift the same way.
export const canonical = (v) => JSON.stringify(v, (_, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b))) : x));

// Drift AWS or the provider makes on its own, seen on this stack and reviewed: RDS's restore mark, Cognito's user counter, a null read back
// as empty (also nested, and for CloudFront as an empty list), the alarm subscription confirmed (true -> false only), an attribute a
// provider upgrade added read for the first time (named attributes, null -> a value only), and a role reading back as inline policies the
// aws_iam_role_policy resources Terraform already holds for it (same name and document; any other inline policy is still drift).
const SELF_MOVING = { aws_db_instance: ['latest_restorable_time'], aws_cognito_user_pool: ['estimated_number_of_users'] };
// hashicorp/aws 6.70.0 -> 6.72.0 (#295): neither attribute is in the 6.70.0 provider.
const NEW_IN_PROVIDER = { aws_cloudtrail: ['recursive_logging'], aws_db_instance: ['multi_tenant'] };
const nullToEmpty = (b, a) => b === null && (canonical(a) === '[]' || canonical(a) === '{}');
const firstRead = (type, k, b, a) => (NEW_IN_PROVIDER[type] ?? []).includes(k) && (b === null || b === undefined) && ['boolean', 'number', 'string'].includes(typeof a);
const policyDoc = (s) => { try { return canonical(JSON.parse(s)); } catch { return undefined; } };
const heldPolicies = (plan, role) => {
  const walk = (m) => [...(m?.resources ?? []), ...(m?.child_modules ?? []).flatMap(walk)];
  return walk(plan?.prior_state?.values?.root_module).filter((r) => r.mode === 'managed' && r.type === 'aws_iam_role_policy' && r.values?.role === role);
};
const ownPolicies = (plan, d, b, a) => {
  if (d.type !== 'aws_iam_role' || !(b === null || Array.isArray(b)) || !Array.isArray(a) || a.length === 0 || typeof d.change.after.name !== 'string') return false;
  const held = heldPolicies(plan, d.change.after.name);
  const same = (h, p) => h.values.name === p?.name && policyDoc(h.values.policy) !== undefined && policyDoc(h.values.policy) === policyDoc(p?.policy);
  return new Set(a.map((p) => p?.name)).size === a.length && a.every((p) => held.some((h) => same(h, p)));
};
const normalised = (emptyList) => function norm(v) {
  if (v === null || (emptyList && Array.isArray(v) && v.length === 0) || (v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0)) return null;
  if (Array.isArray(v)) return v.map(norm);
  return v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, norm(x)])) : v;
};
const deepNullOnly = (b, a, emptyList = false) => canonical(b) !== canonical(a) && canonical(normalised(emptyList)(b)) === canonical(normalised(emptyList)(a));
const confirmed = (type, k, b, a) => type === 'aws_sns_topic_subscription' && k === 'pending_confirmation' && b === true && a === false;
// `plan` is the whole plan: a role's read-back is checked against the policies in its prior state.
export const harmlessDrift = (d, plan) => {
  const { actions, before, after } = d.change ?? {};
  if (d.mode !== 'managed' || canonical(actions) !== canonical(['update']) || !before || !after) return false;
  const moved = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((k) => canonical(before[k]) !== canonical(after[k]));
  return moved.length > 0 && moved.every((k) => (SELF_MOVING[d.type] ?? []).includes(k) || nullToEmpty(before[k], after[k]) || confirmed(d.type, k, before[k], after[k])
    || firstRead(d.type, k, before[k], after[k]) || (k === 'inline_policy' && ownPolicies(plan, d, before[k], after[k]))
    || (d.type === 'aws_cloudwatch_log_metric_filter' && k === 'metric_transformation' && deepNullOnly(before[k], after[k]))
    || (d.type === 'aws_cloudfront_distribution' && k === 'ordered_cache_behavior' && deepNullOnly(before[k], after[k], true)));
};
