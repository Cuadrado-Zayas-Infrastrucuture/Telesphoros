// Narrow configuration-only plans. Existing MIGRATE/IMAGE/INFRA shapes are not changed.
import { canonical, harmlessDrift } from './plan-drift.mjs';

const imagePattern = /^([0-9]{12})\.dkr\.ecr\.us-east-2\.amazonaws\.com\/telesphoros-staging-api@sha256:[0-9a-f]{64}$/;
const computed = ['arn', 'arn_without_revision', 'id', 'revision'];
// Read back by the provider on every replacement, not set here (first real FENCE-CLOSE plan, 2026-11-02): fault injection, which must stay off,
// and each volume's configure_at_launch.
const providerComputed = (path) => path === 'enable_fault_injection' || /^volume\.[0-9]+\.configure_at_launch$/.test(path);
const unknowns = (value, prefix = '') => value === true ? [prefix] : value && typeof value === 'object'
  ? Object.entries(value).flatMap(([key, child]) => unknowns(child, prefix ? `${prefix}.${key}` : key)) : [];
const without = (value, keys) => Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)));
// AWS stores an unchanged definition with empty strings, lists and maps where the configuration has none, and with hostPort equal to
// containerPort (awsvpc). Those read as absent on both sides, so only a real difference remains.
const empty = (v) => v === null || v === '' || (Array.isArray(v) && v.length === 0) || (v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0);
const settled = (v) => Array.isArray(v) ? v.map(settled) : v && typeof v === 'object'
  ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, settled(x)]).filter(([, x]) => !empty(x))) : v;
const off = (v) => v === false || v === null || v === undefined;
function definition(value) {
  const containers = JSON.parse(value.container_definitions);
  if (!Array.isArray(containers) || containers.length !== 1 || containers[0].name !== 'api') throw new Error();
  const container = containers[0];
  if (!Array.isArray(container.environment) || !container.environment.every((e) => typeof e.name === 'string' && typeof e.value === 'string') ||
    new Set(container.environment.map((e) => e.name)).size !== container.environment.length) throw new Error();
  if (container.environmentFiles !== undefined && (!Array.isArray(container.environmentFiles) || container.environmentFiles.length) ||
    container.secrets !== undefined && (!Array.isArray(container.secrets) || container.secrets.some((s) => s.name === 'MEDICATION_WRITES'))) throw new Error();
  const flag = container.environment.find((e) => e.name === 'MEDICATION_WRITES')?.value;
  const remaining = container.environment.filter((e) => e.name !== 'MEDICATION_WRITES').sort((a, b) => a.name.localeCompare(b.name));
  const ports = container.portMappings?.map(({ hostPort, ...port }) => (hostPort === undefined || hostPort === port.containerPort ? port : { ...port, hostPort }));
  const volumes = value.volume?.map((volume) => without(volume, ['configure_at_launch']));
  return { flag, image: container.image, normal: settled({ ...without(value, [...computed, 'enable_fault_injection']), volume: volumes,
    container_definitions: [{ ...container, portMappings: ports, environment: remaining }] }) };
}

export function fenceProblems(mode, plan, oldImage, newImage) {
  const out = [];
  const need = (ok, reason) => { if (!ok) out.push(reason); };
  try {
    const image = imagePattern.exec(oldImage ?? '');
    if (!['FENCE-CLOSE', 'FENCE-OPEN'].includes(mode) || !image || oldImage !== newImage) return ['fence transitions require one unchanged digest-pinned staging image'];
    if (!plan || !/^1\./.test(plan.format_version ?? '') || !Array.isArray(plan.resource_changes)) return ['invalid fence plan'];
    need(plan.complete === true && plan.applyable === true && plan.errored !== true, 'fence plan must be complete, applicable and error-free');
    const variable = (key) => plan.variables?.[key]?.value;
    need(variable('deployment_profile') === 'synthetic' && variable('environment') === 'staging' && variable('region') === 'us-east-2', 'fence target must be synthetic us-east-2 staging');
    need(variable('api_image') === oldImage && variable('api_migrate_image') === oldImage, 'fence plan must keep both image variables unchanged');
    need(variable('medication_writes_enabled') === (mode === 'FENCE-OPEN'), 'fence variable must match the requested direction');
    need(plan.resource_drift === undefined || Array.isArray(plan.resource_drift) && plan.resource_drift.every((d) => canonical(d.change?.actions) === '["no-op"]' || harmlessDrift(d)), 'fence plan has drift outside the reviewed harmless list');
    need(plan.output_changes === undefined || plan.output_changes !== null && typeof plan.output_changes === 'object' && Object.values(plan.output_changes).every((v) => canonical(v.actions) === '["no-op"]'), 'fence plan must not change outputs');
    const changes = plan.resource_changes.filter((r) => !['["no-op"]', '["read"]'].includes(canonical(r.change?.actions)));
    const task = changes.find((r) => r.address === 'aws_ecs_task_definition.api[0]');
    const service = changes.find((r) => r.address === 'aws_ecs_service.api[0]');
    if (changes.length !== 2 || !task || !service || changes.some((r) => r.mode !== 'managed' || r.deposed || r.change?.importing)) return [...out, 'fence plan changes only the API task definition and service'];
    need(task.type === 'aws_ecs_task_definition' && ['["delete","create"]', '["create","delete"]'].includes(canonical(task.change.actions)), 'fence plan must replace the API task definition');
    need(service.type === 'aws_ecs_service' && canonical(service.change.actions) === '["update"]', 'fence plan must update the API service in place');
    const before = definition(task.change.before);
    const after = definition(task.change.after);
    need(before.image === oldImage && after.image === oldImage, 'fence task images must remain unchanged');
    need(canonical(before.normal) === canonical(after.normal), 'fence task definition changes beyond the medication setting');
    need(after.flag === (mode === 'FENCE-OPEN' ? 'enabled' : 'disabled') && (mode === 'FENCE-OPEN' ? before.flag === 'disabled' : before.flag === undefined || before.flag === 'enabled'), 'fence task setting must make the requested transition');
    need(computed.every((key) => task.change.after_unknown?.[key] !== true || task.change.after[key] == null) && task.change.after_unknown?.arn === true && unknowns(task.change.after_unknown).every((key) => computed.includes(key) || providerComputed(key)), 'fence task has unexpected unknown attributes');
    need(off(task.change.before.enable_fault_injection) && (task.change.after_unknown?.enable_fault_injection === true ? task.change.after.enable_fault_injection == null : off(task.change.after.enable_fault_injection)),
      'fence task must keep fault injection off');
    const arn = task.change.before.arn;
    const family = `arn:aws:ecs:us-east-2:${image[1]}:task-definition/telesphoros-staging-api:`;
    need(typeof arn === 'string' && arn.startsWith(family) && /^[1-9][0-9]*$/.test(arn.slice(family.length)) && task.change.before.family === 'telesphoros-staging-api', 'fence source task identity is invalid');
    const s = service.change;
    need(s.before.wait_for_steady_state === true && s.after.wait_for_steady_state === true && Number.isInteger(s.after.desired_count) && s.after.desired_count > 0, 'fence service must retain serving capacity and wait for steady state');
    need(s.before.task_definition === arn && s.after.task_definition == null && s.after_unknown?.task_definition === true &&
      unknowns(s.after_unknown).every((key) => key === 'task_definition') && canonical(without(s.before, ['task_definition'])) === canonical(without(s.after, ['task_definition'])),
    'fence service may only move its task definition');
    const config = plan.configuration?.root_module?.resources?.find((r) => r.address === 'aws_ecs_service.api');
    const references = config?.expressions?.task_definition?.references;
    const allowed = ['aws_ecs_task_definition.api[0].arn', 'aws_ecs_task_definition.api[0]', 'aws_ecs_task_definition.api'];
    need(Array.isArray(references) && references.includes('aws_ecs_task_definition.api[0].arn') && references.every((r) => allowed.includes(r)), 'fence service must reference the API task definition');
  } catch {
    out.push('invalid fence plan attributes');
  }
  return out;
}
