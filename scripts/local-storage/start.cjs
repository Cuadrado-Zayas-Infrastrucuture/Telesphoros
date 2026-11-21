const { setup, teardown, restartApi, sweepNow, health } = require('./runtime.cjs');
let requested = false, wake;
async function main() {
  if (process.argv[2] === 'sweep') { await sweepNow(process.argv[3]); console.log('Owned reconciliation verified.'); return; }
  if (process.argv[2] === 'restart-api') { await restartApi(process.argv[3]); console.log('Owned API restart reconciled.'); return; }
  if (process.argv[2] === 'teardown') { await teardown(process.argv[3]); console.log('Owned teardown verified.'); return; }
  if (process.argv[2] !== 'start') throw new Error('Use start or teardown <run UUID>');
  const run = await setup();
  console.log(`Synthetic storage ready: http://127.0.0.1:${run.ports.web}; run ${run.id}`);
  let unhealthy = false;
  const monitor = setInterval(() => {
    try {
      const status = health(run.id);
      if (status === 'unhealthy') { unhealthy = true; wake?.(); }
      else if (status === 'removed') wake?.();
      // A receipted live operation owns maintenance; inspect after its lock releases.
    }
    catch { unhealthy = true; wake?.(); }
  }, 1000);
  try { if (!requested) await new Promise(resolve => { wake = resolve; }); }
  finally { clearInterval(monitor); await teardown(run.id); }
  if (unhealthy) throw new Error('Owned service stopped unexpectedly; run removed.');
}
// The launchers' own fixed messages, printed as written. Anything else (a system error can carry a path)
// is reduced to its name and code, so a CI log names the cause without exposing paths or data.
const FIXED = [
  /^Local (ownership verification refused|process identity mismatch); resources retained\.$/,
  /^Owned (process stop deadline; retained for recovery|readiness deadline|service startup deadline|service stopped unexpectedly; run removed|operation in progress; retry after it completes)\.?$/,
  /^Owned service exited: (postgres|moto|api|idp|web)$/,
  /^Occupied local port; no service was contacted or stopped\.$/,
  /^Child receipt mismatch$/,
  /^Partial setup retained owned run [0-9a-f-]{36}; explicit teardown required\.$/,
];
function failureCause(error) {
  const message = typeof error?.message === 'string' ? error.message : '';
  if (FIXED.some(pattern => pattern.test(message))) return 'Cause: ' + message;
  const name = typeof error?.name === 'string' && /^[A-Za-z]{1,40}$/.test(error.name) ? error.name : 'Error';
  const code = typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{1,40}$/.test(error.code) ? ' ' + error.code : '';
  return `Cause: ${name}${code} (message withheld)`;
}
if (require.main === module) {
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { requested = true; wake?.(); });
  main().catch(error => {
    console.error('Local storage operation failed; inspect private run/control state.');
    console.error(failureCause(error));
    process.exitCode = 1;
  });
}
module.exports = { failureCause };
