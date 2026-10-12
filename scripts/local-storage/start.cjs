const { setup, teardown, restartApi, sweepNow } = require('./runtime.cjs');
const o = require('./ownership.cjs');
let requested = false, wake;
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { requested = true; wake?.(); });
async function main() {
  if (process.argv[2] === 'sweep') { await sweepNow(process.argv[3]); console.log('Owned reconciliation verified.'); return; }
  if (process.argv[2] === 'restart-api') { await restartApi(process.argv[3]); console.log('Owned API restart reconciled.'); return; }
  if (process.argv[2] === 'teardown') { await teardown(process.argv[3]); console.log('Owned teardown verified.'); return; }
  if (process.argv[2] !== 'start') throw new Error('Use start or teardown <run UUID>');
  const run = await setup();
  console.log(`Synthetic storage ready: http://127.0.0.1:${run.ports.web}; run ${run.id}`);
  let unhealthy = false;
  const monitor = setInterval(() => {
    try { if (!o.load(run.id).processes.every(o.live)) { unhealthy = true; wake?.(); } }
    catch { unhealthy = true; wake?.(); }
  }, 1000);
  try { if (!requested) await new Promise(resolve => { wake = resolve; }); }
  finally { clearInterval(monitor); await teardown(run.id); }
  if (unhealthy) throw new Error('Owned service stopped unexpectedly; run removed.');
}
main().catch(() => { console.error('Local storage operation failed; inspect private run/control state.'); process.exitCode = 1; });
