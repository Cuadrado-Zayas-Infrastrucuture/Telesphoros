// No overlapping sweeps. Wall-clock evidence is independent of the monotonic timer.
const INTERVAL_MS = 15 * 60 * 1000;
function scheduler(sweep, { interval = INTERVAL_MS, later = setTimeout, cancel = clearTimeout, record = () => {} } = {}) {
  let timer, active, stopped = false;
  async function run() {
    if (active) return active;
    active = (async () => {
      try { const result = await sweep(); record({ success: true, result }); return result; }
      catch (error) { record({ success: false }); throw error; }
      finally { active = undefined; }
    })();
    return active;
  }
  function arm() {
    if (!stopped) timer = later(async () => { try { await run(); } catch { /* Cleanup persists stalled admission. */ } finally { arm(); } }, interval);
  }
  return { run, async start() { await run(); arm(); }, async stop() { stopped = true; cancel(timer); if (active) await active.catch(() => {}); } };
}
function clockCheck({ hostBefore, hostAfter, database, emulator }, maxSkewMs = 5000) {
  if (![hostBefore, hostAfter, database, emulator].every(Number.isFinite) || hostAfter < hostBefore || hostAfter - hostBefore > maxSkewMs || Math.max(...[database, emulator].map(t => Math.max(hostBefore - t, t - hostAfter, 0))) > maxSkewMs) throw new Error('Clock synchronization refused.');
  return { maxSkewMs, requestDurationMs: hostAfter - hostBefore, databaseOffsetMs: database - hostAfter, emulatorOffsetMs: emulator - hostAfter, emulatorClockSource: 'HTTP Date from owned native Moto process (same host clock)', passed: true };
}
function guardAdmission(reconcile, enable, disable, record = () => {}) {
  return async () => {
    try { const result = await reconcile(); await record({ success: true, result }); await enable(); return result; }
    catch (error) {
      await disable();
      // Recording can itself be the failure. Admission is already closed, and the
      // original failure must survive even when its failure receipt cannot be saved.
      try { await record({ success: false }); } catch { /* Retry requires a durable success. */ }
      throw error;
    }
  };
}
module.exports = { guardAdmission, scheduler, clockCheck, INTERVAL_MS };
