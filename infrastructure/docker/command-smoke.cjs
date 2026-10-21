// Local/CI only. Runs every ECS task command that Terraform gives the API image through the image's REAL ENTRYPOINT, the way ECS does: `docker run IMAGE <command...>`
// replaces only the image's CMD. The rehearsal driver starts its processes with `spawn(process.execPath, [...])` inside a container, which skips the ENTRYPOINT, so it
// cannot see a command that repeats `node` (`node node worker/main.js`: "Cannot find module '/app/node'"). With no network and no configuration every one of these
// processes refuses to start and exits; all that is checked is that Node found the script, not that the process works. Output is never printed (a refusal can name a variable).
const {spawnSync} = require('node:child_process');
const {readdirSync, readFileSync} = require('node:fs');
const {join, resolve} = require('node:path');
const terraform = resolve(__dirname, '../terraform');
const NOT_FOUND = /Cannot find module|MODULE_NOT_FOUND|ERR_MODULE_NOT_FOUND/;

/** [{file, command}] for every container of the API image in the Terraform root that carries a plain `command`, read by the same code as the entrypoint guard. */
async function taskCommands() {
  const {apiImageContainers, commandList} = await import('../terraform/entrypoint.mjs');
  const found = [];
  for (const file of readdirSync(terraform).filter(f => f.endsWith('.tf')).sort()) {
    for (const container of apiImageContainers(readFileSync(join(terraform, file), 'utf8'))) {
      const command = commandList(container);
      if (command) found.push({file, command});
    }
  }
  return found;
}

/** Throws unless there are at least four commands (worker, migration, provisioning, issuer) and none of them makes Node look for a module that is not there. */
async function smoke(tag, {timeoutMs = 60000, commands = taskCommands, run = spawnSync} = {}) {
  const tasks = await commands();
  if (tasks.length < 4) throw new Error(`command smoke found ${tasks.length} task commands, expected at least 4`);
  for (const {file, command} of tasks) {
    const result = run('docker', ['run', '--rm', '--network', 'none', tag, ...command], {encoding: 'utf8', timeout: timeoutMs, maxBuffer: 1024 * 1024});
    const output = `${result.stdout || ''}${result.stderr || ''}`;
    if (NOT_FOUND.test(output)) throw new Error(`task command from ${file} does not start under the image ENTRYPOINT: ${command.join(' ')}`);
    if (result.error && result.error.code !== 'ETIMEDOUT') throw result.error;
  }
  return tasks.length;
}

module.exports = {smoke, taskCommands, NOT_FOUND};
