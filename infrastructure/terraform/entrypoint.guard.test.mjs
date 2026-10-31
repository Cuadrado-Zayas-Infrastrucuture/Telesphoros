// Guard for the image's ENTRYPOINT against every ECS task `command` that runs it. Imported by guard.test.mjs, so `pnpm test:infra` runs it.
// api.Dockerfile sets ENTRYPOINT ["node"] and CMD ["dist/main.js"]. An ECS container-definition `command` replaces only the image's CMD, so a command that
// starts with "node" runs `node node ...` and dies with "Cannot find module '/app/node'". This keeps any task from dying that way.
// A health check (`healthCheck.command = ["CMD", "node", "-e", ...]`) is not covered and must not be: ECS runs it directly, bypassing the ENTRYPOINT.
// Like the other guards it reads Terraform TEXT. `entrypointProblems` returns what is wrong with a set of files (empty when nothing is); the tests run it on the
// real files and on deliberately broken copies, so every rule has been seen to fail.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { apiImageContainers, code, commandHead, imageEntrypoint } from './entrypoint.mjs';

const dir = new URL('./', import.meta.url);
const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const dockerfile = read('../docker/api.Dockerfile');
const runTask = read('../../scripts/staging/run-task.sh');
const files = Object.fromEntries(readdirSync(dir).filter((f) => f.endsWith('.tf')).map((f) => [f, read(`./${f}`)]));

/** What is wrong with the Terraform files `tf` (name -> text) given the Dockerfile `docker`, as a list of sentences. */
export function entrypointProblems(tf = files, docker = dockerfile) {
  const problems = [];
  const entry = imageEntrypoint(docker);
  if (!entry) problems.push('api.Dockerfile must give its ENTRYPOINT in exec form (a JSON list): this guard cannot judge a task command against anything else');
  let commands = 0;
  for (const [name, text] of Object.entries(tf)) {
    for (const container of apiImageContainers(text)) {
      const head = commandHead(container);
      if (head === undefined) continue;
      commands++;
      if (entry && head === entry[0]) {
        problems.push(`${name}: a task command that runs the API image must not start with "${head}": the image ENTRYPOINT already is ${JSON.stringify(entry)} and the command only replaces its CMD (write the script path, as issuer.tf does)`);
      }
    }
  }
  // A floor, so a scan that finds nothing (a renamed key, a changed layout) cannot pass: the worker, the migration, the provisioning and the issuer tasks carry one each.
  if (commands < 4) problems.push(`the scan must find the task commands that run the API image (found ${commands}, expected at least 4: worker, migration, provisioning, issuer)`);
  return problems;
}

/**
 * The same rule for the container override scripts/staging/run-task.sh hands to `aws ecs run-task`: an override `command` replaces the image's CMD exactly as the
 * task definition's does, so it must not start with the ENTRYPOINT either.
 */
export function overrideProblems(script = runTask, docker = dockerfile) {
  const entry = imageEntrypoint(docker);
  const heads = [...code(script).matchAll(/containerOverrides:\s*\[\{[^\n]*?command:\s*\[\s*"([^"]*)"/g)].map((m) => m[1]);
  const problems = [];
  if (heads.length === 0) problems.push('the scan must find the container override in scripts/staging/run-task.sh');
  for (const head of heads) if (entry && head === entry[0]) problems.push(`scripts/staging/run-task.sh: the container override command must not start with "${head}": the image ENTRYPOINT already is ${JSON.stringify(entry)}`);
  return problems;
}

test('no task command repeats the image ENTRYPOINT (the real files)', () => {
  assert.deepEqual(entrypointProblems(), []);
  assert.deepEqual(overrideProblems(), []);
  assert.deepEqual(imageEntrypoint(dockerfile), ['node']); // control: the premise of every rule below
});

test('the entrypoint guard has been seen to fail', () => {
  const real = { ...files };
  const withNode = (name, from, to) => {
    assert.ok(real[name].includes(from), `the control for ${name} must match the real text (it does not: fix the control)`);
    return { ...real, [name]: real[name].replace(from, to) };
  };
  const cases = [
    ['the worker repeats node', withNode('worker.tf', 'command                = ["worker/main.js"]', 'command                = ["node", "worker/main.js"]')],
    ['the migration repeats node', withNode('api-compute.tf', 'command                = ["dist/db/cli.js", "migrate", "up"]', 'command                = ["node", "dist/db/cli.js", "migrate", "up"]')],
    ['the provisioning repeats node', withNode('api-compute.tf', 'command                = ["dist/db/cli.js", "provision-logins"]', 'command                = ["node", "dist/db/cli.js", "provision-logins"]')],
    ['the issuer repeats node', withNode('issuer.tf', 'command                = ["dist/issuer/main.js"]', 'command                = ["node", "dist/issuer/main.js"]')],
    ['node on one line with the image on the migration image variable', {
      ...real,
      'extra.tf': '  container_definitions = jsonencode([{\n    name = "x"\n    image = var.api_migrate_image != "" ? var.api_migrate_image : var.api_image\n    command = ["node", "dist/db/cli.js"]\n  }])\n',
    }],
    ['a new task in a new file repeats node', { ...real, 'extra.tf': '  container_definitions = jsonencode([{\n    name = "x"\n    image = var.api_image\n    command = ["node", "dist/main.js"]\n  }])\n' }],
    ['the scan finds no task commands', {}],
    ['the scan finds a file with no containers', { 'extra.tf': 'resource "aws_ecs_cluster" "x" {}\n' }],
  ];
  for (const [name, tf] of cases) assert.ok(entrypointProblems(tf).length > 0, `a weakened text must be reported: ${name}`);

  // The Dockerfile side: a changed ENTRYPOINT must not leave the rule silently comparing against nothing.
  assert.ok(entrypointProblems(files, dockerfile.replace('ENTRYPOINT ["node"]', 'ENTRYPOINT node')).length > 0, 'a shell-form ENTRYPOINT must be reported');
  assert.ok(entrypointProblems(files, dockerfile.replace('ENTRYPOINT ["node"]\n', '')).length > 0, 'a missing ENTRYPOINT must be reported');
  // And the rule follows the Dockerfile rather than the word "node": under another ENTRYPOINT the old commands are not this guard's concern, the new head is.
  assert.deepEqual(entrypointProblems(files, dockerfile.replace('ENTRYPOINT ["node"]', 'ENTRYPOINT ["/usr/bin/tini", "--"]')), []);

  // The override script: node put back, and a script the scan cannot read.
  assert.ok(runTask.includes('command: ["dist/db/cli.js", ...command]'), 'the control for run-task.sh must match the real text (it does not: fix the control)');
  assert.ok(overrideProblems(runTask.replace('command: ["dist/db/cli.js", ...command]', 'command: ["node", "dist/db/cli.js", ...command]')).length > 0, 'an override that repeats node must be reported');
  assert.ok(overrideProblems('').length > 0, 'a script with no override must be reported (the scan cannot pass on nothing)');

  // Things that must NOT be reported: a health check and a container that does not run the API image.
  const health = { ...real, 'extra.tf': '  container_definitions = jsonencode([{\n    name = "x"\n    image = var.api_image\n    command = ["dist/main.js"]\n    healthCheck = { command = ["CMD", "node", "-e", "1"] }\n  }])\n' };
  assert.deepEqual(entrypointProblems(health), []); // control: the nested health check is not the container's command
  const other = { ...real, 'extra.tf': '  container_definitions = jsonencode([{\n    name = "y"\n    image = var.some_other_image\n    command = ["node", "x.js"]\n  }])\n' };
  assert.deepEqual(entrypointProblems(other), []); // control: only containers of the API image are judged
  assert.deepEqual(entrypointProblems(files, dockerfile), []); // control: the unchanged text is clean
});

// The image rehearsal runs the same commands through the image's real ENTRYPOINT (infrastructure/docker/command-smoke.cjs). `docker` is not available to this
// suite, so the smoke is driven here with a stand-in for `docker run` that answers the way the image does; the real run is the image job's rehearsal.
const smokeModule = createRequire(import.meta.url)('../docker/command-smoke.cjs');
const rehearsal = read('../docker/rehearsal.cjs');
/** What is wrong with the rehearsal script's use of the smoke (a sentence each, empty when nothing is). */
export function rehearsalProblems(source = rehearsal) {
  const text = code(source.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n'));
  const problems = [];
  if (!/require\('\.\/command-smoke\.cjs'\)/.test(text)) problems.push('rehearsal.cjs must load command-smoke.cjs');
  const call = text.search(/await smoke\(tag\)/);
  if (call < 0) problems.push('rehearsal.cjs must run the command smoke on the image under test');
  else if (call > text.indexOf("docker('network','create'")) problems.push('the command smoke must run before the first container or network is created');
  return problems;
}
const answering = (output) => () => ({ status: 1, stdout: '', stderr: output });
const four = async () => ['worker.tf', 'api-compute.tf', 'api-compute.tf', 'issuer.tf'].map((file) => ({ file, command: ['x/main.js'] }));

test('the rehearsal runs every task command through the image ENTRYPOINT', async () => {
  const found = await smokeModule.taskCommands();
  assert.ok(found.length >= 4, `the smoke must find the task commands (found ${found.length})`);
  assert.ok(found.some(({ file, command }) => file === 'worker.tf' && command.join(' ') === 'worker/main.js'), 'the worker command is among them');
  assert.deepEqual(rehearsalProblems(), []);
  assert.equal(await smokeModule.smoke('t', { commands: four, run: answering('worker failed to start: Worker settings are invalid: DATABASE_URL.') }), 4); // control: a refusal for missing configuration passes
});

test('the command smoke has been seen to fail', async () => {
  const reject = (options, message) => assert.rejects(smokeModule.smoke('t', options), message);
  await reject({ commands: four, run: answering("Error: Cannot find module '/app/node'") }, /does not start under the image ENTRYPOINT/);
  await reject({ commands: four, run: answering('Error [ERR_MODULE_NOT_FOUND]: x') }, /does not start under the image ENTRYPOINT/);
  await reject({ commands: async () => (await four()).slice(0, 3), run: answering('') }, /expected at least 4/);
  await reject({ commands: async () => [], run: answering('') }, /expected at least 4/);
  const docker = (code) => () => ({ error: Object.assign(new Error('x'), { code }), stdout: '', stderr: '' });
  await reject({ commands: four, run: docker('ENOENT') }, /x/); // docker missing is a failure, not a pass
  assert.equal(await smokeModule.smoke('t', { commands: four, run: docker('ETIMEDOUT') }), 4); // control: a process that keeps running found its script
  // The script that runs it.
  assert.ok(rehearsal.includes('await smoke(tag)'), 'the control for rehearsal.cjs must match the real text (it does not: fix the control)');
  assert.ok(rehearsalProblems(rehearsal.replace("  console.log(`PASS ${await smoke(tag)}", "  console.log(`PASS ${4}")).length > 0, 'a rehearsal that never runs the smoke must be reported');
  assert.ok(rehearsalProblems(rehearsal.replace("const {smoke}=require('./command-smoke.cjs');\n", '')).length > 0, 'a rehearsal that does not load the smoke must be reported');
  const late = rehearsal.replace(/  console\.log\(`PASS \$\{await smoke\(tag\)\}[^\n]*\n/, '').replace("docker('network','create',network);networkCreated=true;", "docker('network','create',network);networkCreated=true;await smoke(tag);");
  assert.ok(rehearsalProblems(late).length > 0, 'a smoke that runs after the network is created must be reported');
});
