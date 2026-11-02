// Invented Terraform show JSON; never a live account or saved plan.
export const FENCE_IMAGE = '111122223333.dkr.ecr.us-east-2.amazonaws.com/telesphoros-staging-api@sha256:' + 'a'.repeat(64);
export function fencePlan(mode = 'FENCE-CLOSE', missing = false, runningImage = FENCE_IMAGE) {
  const opening = mode === 'FENCE-OPEN';
  const arn = 'arn:aws:ecs:us-east-2:111122223333:task-definition/telesphoros-staging-api:12';
  const before = { arn, id: arn, arn_without_revision: arn.slice(0, arn.lastIndexOf(':')), revision: 12, family: 'telesphoros-staging-api', cpu: '512',
    container_definitions: JSON.stringify([{ name: 'api', image: runningImage, environment: [{ name: 'NODE_ENV', value: 'production' },
      ...(missing ? [] : [{ name: 'MEDICATION_WRITES', value: opening ? 'disabled' : 'enabled' }])], secrets: [], readonlyRootFilesystem: true }]) };
  const after = { ...before, arn: null, id: null, arn_without_revision: null, revision: null,
    container_definitions: JSON.stringify([{ name: 'api', image: runningImage, environment: [{ name: 'NODE_ENV', value: 'production' },
      { name: 'MEDICATION_WRITES', value: opening ? 'enabled' : 'disabled' }], secrets: [], readonlyRootFilesystem: true }]) };
  return { format_version: '1.2', complete: true, applyable: true, errored: false, resource_drift: [], output_changes: {},
    variables: Object.fromEntries(Object.entries({ deployment_profile: 'synthetic', environment: 'staging', region: 'us-east-2',
      api_image: runningImage, api_migrate_image: runningImage, medication_writes_enabled: opening }).map(([k, value]) => [k, { value }])),
    configuration: { root_module: { resources: [{ address: 'aws_ecs_service.api', expressions: { task_definition: { references: ['aws_ecs_task_definition.api[0].arn', 'aws_ecs_task_definition.api'] } } }] } },
    resource_changes: [
      { address: 'aws_ecs_task_definition.api[0]', mode: 'managed', type: 'aws_ecs_task_definition', change: { actions: ['delete', 'create'], before, after,
        after_unknown: { arn: true, id: true, arn_without_revision: true, revision: true } } },
      { address: 'aws_ecs_service.api[0]', mode: 'managed', type: 'aws_ecs_service', change: { actions: ['update'], before: { task_definition: arn, desired_count: 1, wait_for_steady_state: true },
        after: { task_definition: null, desired_count: 1, wait_for_steady_state: true }, after_unknown: { task_definition: true } } },
    ],
  };
}
