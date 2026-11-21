'use strict';
// Runs one command against a freshly started, owned synthetic demo, then stops that demo through its own teardown.
// The required browser job uses it for the investor demo suite: `node scripts/local-storage/product-demo-ci.cjs pnpm test:product-demo`.
// The run fails if the demo never becomes ready, if the command fails, or if the demo does not stop cleanly; the command's own exit code is kept.
const { spawn } = require('node:child_process');
const path = require('node:path');

// The line start.cjs prints once every owned service answers.
const READY = /^Synthetic storage ready: (http:\/\/127\.0\.0\.1:\d+); run ([0-9a-f-]{36})$/m;
const LAUNCHER = [process.execPath, path.join(__dirname, 'start.cjs'), 'start'];

const exited = child => new Promise(resolve => {
  if (child.exitCode !== null || child.signalCode !== null) resolve({ code: child.exitCode, signal: child.signalCode });
  else child.once('exit', (code, signal) => resolve({ code, signal }));
});
const delay = ms => new Promise(resolve => setTimeout(resolve, ms, 'timeout').unref());

async function runAgainstDemo(command, { launcher = LAUNCHER, readyMs = 180_000, stopMs = 120_000, log = process.stdout } = {}) {
  if (!command.length) throw new Error('Name the command to run against the demo.');
  const demo = spawn(launcher[0], launcher.slice(1), { stdio: ['ignore', 'pipe', 'pipe'] });
  const demoExit = exited(demo);
  let output = '';
  let timer;
  const ready = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`The demo was not ready within ${readyMs} ms.`)), readyMs);
    demo.stdout.on('data', chunk => {
      log.write(chunk);
      output += chunk;
      const match = READY.exec(output);
      if (match) resolve({ url: match[1], run: match[2] });
    });
    demo.stderr.on('data', chunk => log.write(chunk));
    demo.once('error', reject);
    demoExit.then(({ code, signal }) => reject(new Error(`The demo exited before it was ready (${signal ?? code}).`)));
  }).finally(() => clearTimeout(timer));

  let status = null;
  let problem = null;
  let run = null;
  let current = null;
  const forward = signal => () => current?.kill(signal);
  const handlers = { SIGINT: forward('SIGINT'), SIGTERM: forward('SIGTERM') };
  for (const [signal, handler] of Object.entries(handlers)) process.on(signal, handler);
  try {
    ({ run } = await ready);
    log.write(`Product demo ready (run ${run}); running: ${command.join(' ')}\n`);
    current = spawn(command[0], command.slice(1), { stdio: 'inherit' });
    ({ code: status } = await exited(current));
  } catch (error) {
    problem = error;
  } finally {
    for (const [signal, handler] of Object.entries(handlers)) process.off(signal, handler);
    if (demo.exitCode === null && demo.signalCode === null) demo.kill('SIGINT');
    const stopped = await Promise.race([demoExit, delay(stopMs)]);
    if (stopped === 'timeout') {
      demo.kill('SIGKILL');
      problem ??= new Error(`The demo did not stop within ${stopMs} ms and was killed.`);
    } else if (stopped.code !== 0) {
      problem ??= new Error(`The demo teardown failed (${stopped.signal ?? stopped.code}).`);
    }
  }
  return { status, problem, run };
}

/** A failed command keeps its own code; a problem never reads as success. */
function exitCodeOf({ status, problem }) {
  if (status !== null && status !== 0) return status;
  return problem || status === null ? 1 : 0;
}

if (require.main === module) {
  runAgainstDemo(process.argv.slice(2)).then(result => {
    if (result.problem) console.error(result.problem.message);
    process.exitCode = exitCodeOf(result);
  }, error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = { runAgainstDemo, exitCodeOf };
