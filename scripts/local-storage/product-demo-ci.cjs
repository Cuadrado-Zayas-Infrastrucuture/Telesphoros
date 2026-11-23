'use strict';
// Runs one command against a freshly started, owned synthetic demo, then stops that demo through its own teardown.
// The required browser job uses it for the investor demo suite: `node scripts/local-storage/product-demo-ci.cjs pnpm test:product-demo`.
// The run fails if the demo never becomes ready, if the command fails, or if the demo does not stop; the command's own exit code is kept.
// A teardown that exits non-zero fails the run too, unless PRODUCT_DEMO_TEARDOWN_FAILURE=warn: then it is a warning carrying the launcher's reason.
// The browser job sets warn while an intermittent CI teardown failure is diagnosed (docs/ops/ci-cd.md); a runner is discarded after the job either way.
const { spawn } = require('node:child_process');
const path = require('node:path');

// The line start.cjs prints once every owned service answers, and the reason it prints when asked (LOCAL_STORAGE_SHOW_REASON=1).
const READY = /^Synthetic storage ready: (http:\/\/127\.0\.0\.1:\d+); run ([0-9a-f-]{36})$/m;
const REASON = /^Reason: (.+)$/m;
const LAUNCHER = [process.execPath, path.join(__dirname, 'start.cjs'), 'start'];
const MODES = ['fail', 'warn'];

const exited = child => new Promise(resolve => {
  if (child.exitCode !== null || child.signalCode !== null) resolve({ code: child.exitCode, signal: child.signalCode });
  else child.once('exit', (code, signal) => resolve({ code, signal }));
});
const delay = ms => new Promise(resolve => setTimeout(resolve, ms, 'timeout').unref());

/** The teardown mode named by PRODUCT_DEMO_TEARDOWN_FAILURE: fail (the default) or warn. Anything else is refused, never guessed. */
function teardownModeFrom(env) {
  const mode = env.PRODUCT_DEMO_TEARDOWN_FAILURE || 'fail';
  if (!MODES.includes(mode)) throw new Error(`PRODUCT_DEMO_TEARDOWN_FAILURE must be fail or warn, not ${JSON.stringify(mode)}.`);
  return mode;
}

async function runAgainstDemo(command, { launcher = LAUNCHER, readyMs = 180_000, stopMs = 120_000, teardownFailure = 'fail', log = process.stdout } = {}) {
  if (!command.length) throw new Error('Name the command to run against the demo.');
  if (!MODES.includes(teardownFailure)) throw new Error(`Unknown teardown mode ${JSON.stringify(teardownFailure)}: use fail or warn.`);
  const demo = spawn(launcher[0], launcher.slice(1), { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, LOCAL_STORAGE_SHOW_REASON: '1' } });
  const demoExit = exited(demo);
  let output = '';
  let errors = '';
  let timer;
  const ready = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`The demo was not ready within ${readyMs} ms.`)), readyMs);
    demo.stdout.on('data', chunk => {
      log.write(chunk);
      output += chunk;
      const match = READY.exec(output);
      if (match) resolve({ url: match[1], run: match[2] });
    });
    demo.stderr.on('data', chunk => {
      log.write(chunk);
      errors += chunk;
    });
    demo.once('error', reject);
    demoExit.then(({ code, signal }) => reject(new Error(`The demo exited before it was ready (${signal ?? code}).`)));
  }).finally(() => clearTimeout(timer));

  let status = null;
  let problem = null;
  let warning = null;
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
    } else if (stopped.code !== 0 && problem === null) {
      const reason = REASON.exec(errors)?.[1] ?? 'the launcher gave no reason';
      const message = `The demo teardown failed (${stopped.signal ?? stopped.code}): ${reason}`;
      if (teardownFailure === 'warn') warning = message;
      else problem = new Error(message);
    }
  }
  return { status, problem, warning, run };
}

/** A failed command keeps its own code; a problem never reads as success. A warning alone does not fail the run. */
function exitCodeOf({ status, problem }) {
  if (status !== null && status !== 0) return status;
  return problem || status === null ? 1 : 0;
}

if (require.main === module) {
  Promise.resolve()
    .then(() => runAgainstDemo(process.argv.slice(2), { teardownFailure: teardownModeFrom(process.env) }))
    .then(result => {
      if (result.warning) console.log(`::warning title=Investor demo teardown::${result.warning}`);
      if (result.problem) console.error(result.problem.message);
      process.exitCode = exitCodeOf(result);
    }, error => {
      console.error(error.message);
      process.exitCode = 1;
    });
}

module.exports = { runAgainstDemo, exitCodeOf, teardownModeFrom };
