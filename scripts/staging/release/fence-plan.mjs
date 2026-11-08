// Narrow configuration-only plans. Existing MIGRATE/IMAGE/INFRA shapes are not changed.
// One engine for the reviewed one-flag transitions (fence-vars.mjs): the medication fence and, since spec 032 S3 PR 3c-3a, the synthetic assessment.
// Both keep one image, replace only the API task definition and move its service in place; they differ in WHICH environment settings may change.
import { canonical, harmlessDrift } from './plan-drift.mjs';
import { FLAG_MODES } from './fence-vars.mjs';

/** What ASSESSMENT-ON installs in the API task and ASSESSMENT-OFF removes: exactly what api-compute.tf writes (its guard reads this constant). */
export const ASSESSMENT_SETTINGS = { SYNTHETIC_ASSESSMENT: 'enabled', SYNTHETIC_KNOWLEDGE_DIR: '/app/synthetic-knowledge' };
const FAMILIES = {
  medication: { word: 'fence', what: 'medication setting', variable: 'medication_writes_enabled', names: ['MEDICATION_WRITES'] },
  assessment: { word: 'assessment', what: 'assessment settings', variable: 'synthetic_assessment_enabled', names: Object.keys(ASSESSMENT_SETTINGS) },
};
const MODES = {
  'FENCE-CLOSE': { family: FAMILIES.medication, on: false },
  'FENCE-OPEN': { family: FAMILIES.medication, on: true },
  'ASSESSMENT-OFF': { family: FAMILIES.assessment, on: false },
  'ASSESSMENT-ON': { family: FAMILIES.assessment, on: true },
};
if (canonical(Object.keys(MODES).sort()) !== canonical([...FLAG_MODES].sort())) throw new Error('fence-plan.mjs and fence-vars.mjs disagree about the one-flag modes');

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
function definition(value, names) {
  const containers = JSON.parse(value.container_definitions);
  if (!Array.isArray(containers) || containers.length !== 1 || containers[0].name !== 'api') throw new Error();
  const container = containers[0];
  if (!Array.isArray(container.environment) || !container.environment.every((e) => typeof e.name === 'string' && typeof e.value === 'string') ||
    new Set(container.environment.map((e) => e.name)).size !== container.environment.length) throw new Error();
  if (container.environmentFiles !== undefined && (!Array.isArray(container.environmentFiles) || container.environmentFiles.length) ||
    container.secrets !== undefined && (!Array.isArray(container.secrets) || container.secrets.some((s) => names.includes(s.name)))) throw new Error();
  const settings = Object.fromEntries(names.map((name) => [name, container.environment.find((e) => e.name === name)?.value]));
  const remaining = container.environment.filter((e) => !names.includes(e.name)).sort((a, b) => a.name.localeCompare(b.name));
  const ports = container.portMappings?.map(({ hostPort, ...port }) => (hostPort === undefined || hostPort === port.containerPort ? port : { ...port, hostPort }));
  const volumes = value.volume?.map((volume) => without(volume, ['configure_at_launch']));
  return { settings, image: container.image, normal: settled({ ...without(value, [...computed, 'enable_fault_injection']), volume: volumes,
    container_definitions: [{ ...container, portMappings: ports, environment: remaining }] }) };
}

/** Whether the API task's settings make the requested transition: the medication flag (enabled/disabled), or the assessment's two settings (both or neither). */
function transitionOk({ family, on }, before, after) {
  if (family === FAMILIES.medication) {
    const was = before.settings.MEDICATION_WRITES;
    return after.settings.MEDICATION_WRITES === (on ? 'enabled' : 'disabled') && (on ? was === 'disabled' : was === undefined || was === 'enabled');
  }
  const none = (s) => family.names.every((name) => s[name] === undefined);
  const full = (s) => family.names.every((name) => s[name] === ASSESSMENT_SETTINGS[name]);
  return on ? none(before.settings) && full(after.settings) : full(before.settings) && none(after.settings);
}

export function flagProblems(mode, plan, oldImage, newImage) {
  const out = [];
  const need = (ok, reason) => { if (!ok) out.push(reason); };
  const spec = MODES[mode];
  const w = spec?.family.word ?? 'fence';
  try {
    const image = imagePattern.exec(oldImage ?? '');
    if (!spec || !image || oldImage !== newImage) return [`${w} transitions require one unchanged digest-pinned staging image`];
    if (!plan || !/^1\./.test(plan.format_version ?? '') || !Array.isArray(plan.resource_changes)) return [`invalid ${w} plan`];
    need(plan.complete === true && plan.applyable === true && plan.errored !== true, `${w} plan must be complete, applicable and error-free`);
    const variable = (key) => plan.variables?.[key]?.value;
    need(variable('deployment_profile') === 'synthetic' && variable('environment') === 'staging' && variable('region') === 'us-east-2', `${w} target must be synthetic us-east-2 staging`);
    need(variable('api_image') === oldImage && variable('api_migrate_image') === oldImage, `${w} plan must keep both image variables unchanged`);
    need(variable(spec.family.variable) === spec.on, `${w} variable must match the requested direction`);
    need(plan.resource_drift === undefined || Array.isArray(plan.resource_drift) && plan.resource_drift.every((d) => canonical(d.change?.actions) === '["no-op"]' || harmlessDrift(d, plan)), `${w} plan has drift outside the reviewed harmless list`);
    need(plan.output_changes === undefined || plan.output_changes !== null && typeof plan.output_changes === 'object' && Object.values(plan.output_changes).every((v) => canonical(v.actions) === '["no-op"]'), `${w} plan must not change outputs`);
    const changes = plan.resource_changes.filter((r) => !['["no-op"]', '["read"]'].includes(canonical(r.change?.actions)));
    const task = changes.find((r) => r.address === 'aws_ecs_task_definition.api[0]');
    const service = changes.find((r) => r.address === 'aws_ecs_service.api[0]');
    if (changes.length !== 2 || !task || !service || changes.some((r) => r.mode !== 'managed' || r.deposed || r.change?.importing)) return [...out, `${w} plan changes only the API task definition and service`];
    need(task.type === 'aws_ecs_task_definition' && ['["delete","create"]', '["create","delete"]'].includes(canonical(task.change.actions)), `${w} plan must replace the API task definition`);
    need(service.type === 'aws_ecs_service' && canonical(service.change.actions) === '["update"]', `${w} plan must update the API service in place`);
    const before = definition(task.change.before, spec.family.names);
    const after = definition(task.change.after, spec.family.names);
    need(before.image === oldImage && after.image === oldImage, `${w} task images must remain unchanged`);
    need(canonical(before.normal) === canonical(after.normal), `${w} task definition changes beyond the ${spec.family.what}`);
    need(transitionOk(spec, before, after), `${w} task setting must make the requested transition`);
    need(computed.every((key) => task.change.after_unknown?.[key] !== true || task.change.after[key] == null) && task.change.after_unknown?.arn === true && unknowns(task.change.after_unknown).every((key) => computed.includes(key) || providerComputed(key)), `${w} task has unexpected unknown attributes`);
    need(off(task.change.before.enable_fault_injection) && (task.change.after_unknown?.enable_fault_injection === true ? task.change.after.enable_fault_injection == null : off(task.change.after.enable_fault_injection)),
      `${w} task must keep fault injection off`);
    const arn = task.change.before.arn;
    const family = `arn:aws:ecs:us-east-2:${image[1]}:task-definition/telesphoros-staging-api:`;
    need(typeof arn === 'string' && arn.startsWith(family) && /^[1-9][0-9]*$/.test(arn.slice(family.length)) && task.change.before.family === 'telesphoros-staging-api', `${w} source task identity is invalid`);
    const s = service.change;
    need(s.before.wait_for_steady_state === true && s.after.wait_for_steady_state === true && Number.isInteger(s.after.desired_count) && s.after.desired_count > 0, `${w} service must retain serving capacity and wait for steady state`);
    need(s.before.task_definition === arn && s.after.task_definition == null && s.after_unknown?.task_definition === true &&
      unknowns(s.after_unknown).every((key) => key === 'task_definition') && canonical(without(s.before, ['task_definition'])) === canonical(without(s.after, ['task_definition'])),
    `${w} service may only move its task definition`);
    const config = plan.configuration?.root_module?.resources?.find((r) => r.address === 'aws_ecs_service.api');
    const references = config?.expressions?.task_definition?.references;
    const allowed = ['aws_ecs_task_definition.api[0].arn', 'aws_ecs_task_definition.api[0]', 'aws_ecs_task_definition.api'];
    need(Array.isArray(references) && references.includes('aws_ecs_task_definition.api[0].arn') && references.every((r) => allowed.includes(r)), `${w} service must reference the API task definition`);
  } catch {
    out.push(`invalid ${w} plan attributes`);
  }
  return out;
}
