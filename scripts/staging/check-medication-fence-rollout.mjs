// Offline observation check only. No AWS calls, writes, migration, deployment or request-drain claim.
import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const canonical = (value) => JSON.stringify(value);
const unique = (values) => new Set(values).size === values.length;
const list = (value) => Array.isArray(value) && value.length <= 1000;
const emptyOptional = (value) => value === undefined || list(value) && value.length === 0;
const emptyFailures = (value) => Array.isArray(value?.failures) && value.failures.length === 0;

/** Caller-supplied AWS snapshots are observations, not authenticated proof of live state. */
export function assess(snapshot, now = Date.now()) {
  const reasons = new Set();
  const need = (ok, reason) => { if (!ok) reasons.add(reason); };
  let runningTasks = 0;
  try {
    const expected = snapshot.expected;
    const account = expected.accountId;
    if (typeof account !== 'string' || !/^[0-9]{12}$/.test(account)) throw new Error();
    const prefix = `arn:aws:ecs:us-east-2:${account}:`;
    const cluster = `${prefix}cluster/telesphoros-staging-api`;
    const service = `${prefix}service/telesphoros-staging-api/telesphoros-staging-api`;
    const family = `${prefix}task-definition/telesphoros-staging-api:`;
    const imagePrefix = `${account}.dkr.ecr.us-east-2.amazonaws.com/telesphoros-staging-api@sha256:`;
    if (expected.clusterArn !== cluster || expected.serviceArn !== service ||
      !expected.taskDefinitionArn?.startsWith(family) || !/^[1-9][0-9]*$/.test(expected.taskDefinitionArn.slice(family.length)) ||
      !expected.image?.startsWith(imagePrefix) || !/^[0-9a-f]{64}$/.test(expected.image.slice(imagePrefix.length))) throw new Error();
    const captured = Date.parse(snapshot.capturedAt);
    need(typeof snapshot.capturedAt === 'string' && /Z$/.test(snapshot.capturedAt) && Number.isFinite(captured) &&
      Number.isFinite(now) && now - captured >= -30_000 && now - captured <= 300_000, 'observation-not-current');

    const services = snapshot.services;
    const tasks = snapshot.tasks;
    const running = snapshot.runningTaskArns;
    const stopped = snapshot.stoppedTaskArns;
    if (!list(services?.services) || services.services.length !== 1 || !list(tasks?.tasks) ||
      !list(running?.taskArns) || !list(stopped?.taskArns)) throw new Error();
    need(emptyFailures(services) && emptyFailures(tasks), 'aws-read-incomplete');
    need(!services.nextToken && !tasks.nextToken && !running.nextToken && !stopped.nextToken, 'aws-read-paginated');
    const arns = [...running.taskArns, ...stopped.taskArns];
    const taskPrefix = `${prefix}task/telesphoros-staging-api/`;
    const validArn = (arn) => typeof arn === 'string' && arn.startsWith(taskPrefix) && /^[0-9a-f]{32}$/.test(arn.slice(taskPrefix.length));
    need(arns.every(validArn) && unique(arns), 'task-inventory-invalid');
    const described = tasks.tasks.map((task) => task.taskArn);
    need(described.every(validArn) && unique(described) && canonical([...arns].sort()) === canonical([...described].sort()), 'task-inventory-incomplete');

    const current = services.services[0];
    need(current.serviceArn === service && current.clusterArn === cluster && current.serviceName === 'telesphoros-staging-api' &&
      current.status === 'ACTIVE' && current.taskDefinition === expected.taskDefinitionArn, 'service-identity-mismatch');
    need(Number.isInteger(current.desiredCount) && current.desiredCount > 0 && current.runningCount === current.desiredCount && current.pendingCount === 0,
      'service-not-steady');
    const deployments = current.deployments;
    need(list(deployments) && deployments.length === 1 && deployments[0].status === 'PRIMARY' && deployments[0].rolloutState === 'COMPLETED' &&
      deployments[0].taskDefinition === expected.taskDefinitionArn && deployments[0].desiredCount === current.desiredCount &&
      deployments[0].runningCount === current.desiredCount && deployments[0].pendingCount === 0, 'deployment-not-complete');

    const definition = snapshot.taskDefinition?.taskDefinition;
    need(definition?.taskDefinitionArn === expected.taskDefinitionArn && definition?.status === 'ACTIVE', 'task-definition-mismatch');
    const containers = definition?.containerDefinitions;
    if (!list(containers) || containers.length !== 1 || containers[0].name !== 'api') throw new Error();
    const container = containers[0];
    need(container.image === expected.image, 'task-definition-image-mismatch');
    if (!list(container.environment)) throw new Error();
    const names = container.environment.map((item) => item.name);
    need(names.every((name) => typeof name === 'string') && unique(names) &&
      container.environment.filter((item) => item.name === 'MEDICATION_WRITES').length === 1 &&
      container.environment.find((item) => item.name === 'MEDICATION_WRITES')?.value === 'disabled', 'write-setting-not-explicitly-disabled');
    need(emptyOptional(container.environmentFiles) && (container.secrets === undefined || list(container.secrets) && !container.secrets.some((item) => item.name === 'MEDICATION_WRITES')),
      'write-setting-may-be-overridden');

    for (const task of tasks.tasks) {
      need(task.clusterArn === cluster && task.group === 'service:telesphoros-staging-api', 'task-service-mismatch');
      if (task.lastStatus === 'STOPPED' && task.desiredStatus === 'STOPPED' && stopped.taskArns.includes(task.taskArn)) continue;
      runningTasks += 1;
      need(running.taskArns.includes(task.taskArn) && task.lastStatus === 'RUNNING' && task.desiredStatus === 'RUNNING' && task.healthStatus === 'HEALTHY', 'task-not-stable');
      need(task.taskDefinitionArn === expected.taskDefinitionArn, 'mixed-task-revisions');
      const api = task.containers;
      need(list(api) && api.length === 1 && api[0].name === 'api' && api[0].image === expected.image &&
        api[0].imageDigest === `sha256:${expected.image.slice(imagePrefix.length)}` && api[0].lastStatus === 'RUNNING' && api[0].healthStatus === 'HEALTHY', 'task-image-or-health-mismatch');
      const overrides = task.overrides?.containerOverrides;
      need(overrides === undefined || list(overrides) && overrides.every((entry) => entry.name === 'api' &&
        entry.command === undefined && emptyOptional(entry.environmentFiles) && (entry.environment === undefined || list(entry.environment) && !entry.environment.some((item) => item.name === 'MEDICATION_WRITES'))), 'task-write-setting-override');
    }
    need(runningTasks === current.runningCount && runningTasks === running.taskArns.length && runningTasks > 0, 'running-task-count-mismatch');
  } catch {
    reasons.add('invalid-snapshot');
  }
  return { status: reasons.size ? 'hold' : 'observed-disabled', runningTasks, reasons: [...reasons].sort() };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  let result;
  try {
    if (process.argv.length !== 3 || statSync(process.argv[2]).size > 2 * 1024 * 1024) throw new Error();
    result = assess(JSON.parse(readFileSync(process.argv[2], 'utf8')));
  } catch {
    result = { status: 'hold', runningTasks: 0, reasons: ['invalid-snapshot'] };
  }
  console.log(JSON.stringify(result));
  process.exitCode = result.status === 'observed-disabled' ? 0 : 1;
}
