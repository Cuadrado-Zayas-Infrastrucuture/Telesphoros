// Shared by release-check.mjs (MIGRATE/IMAGE/INFRA) and fence-plan.mjs (FENCE-CLOSE/FENCE-OPEN), so every release mode reads drift the same way.
export const canonical = (v) => JSON.stringify(v, (_, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b))) : x));

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
export const harmlessDrift = (d) => {
  const { actions, before, after } = d.change ?? {};
  if (d.mode !== 'managed' || canonical(actions) !== canonical(['update']) || !before || !after) return false;
  const moved = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((k) => canonical(before[k]) !== canonical(after[k]));
  return moved.length > 0 && moved.every((k) => (SELF_MOVING[d.type] ?? []).includes(k) || nullToEmpty(before[k], after[k]) || confirmed(d.type, k, before[k], after[k])
    || (d.type === 'aws_cloudwatch_log_metric_filter' && k === 'metric_transformation' && deepNullOnly(before[k], after[k]))
    || (d.type === 'aws_cloudfront_distribution' && k === 'ordered_cache_behavior' && deepNullOnly(before[k], after[k], true)));
};
