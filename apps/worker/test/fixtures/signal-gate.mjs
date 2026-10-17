// TEST ONLY: hold the application's SIGTERM callback until the process test releases it.
// This forces the send/acknowledgement race without changing the worker or relying on a sleep.
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const directory = process.env.WORKER_TEST_SIGNAL_GATE_DIR;
if (!directory || process.env.WORKER_TEST_JOBS !== 'yes') throw new Error('Explicit test signal-gate configuration required');
const on = process.on;
process.on = function (event, listener) {
  if (event !== 'SIGTERM') return on.call(this, event, listener);
  return on.call(this, event, function (...args) {
    writeFileSync(join(directory, 'signal-held'), 'held\n', { flag: 'wx', mode: 0o600 });
    const limit = setTimeout(() => {
      clearInterval(poll);
      process.stderr.write('Test signal gate was not released.\n');
      process.exit(97);
    }, 10_000);
    const poll = setInterval(() => {
      if (!existsSync(join(directory, 'release-signal'))) return;
      clearInterval(poll);
      clearTimeout(limit);
      listener.apply(this, args);
    }, 5);
  });
};
