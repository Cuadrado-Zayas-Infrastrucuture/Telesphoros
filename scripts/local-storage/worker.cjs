// Gated worker: the parent durably records this PID/start identity before permitting
// any service to launch. A disconnected, ungated worker exits without starting resources.
const { spawn } = require('node:child_process');
const fs = require('node:fs'); const path = require('node:path');
const o = require('./ownership.cjs');
const [id, name] = process.argv.slice(2);
let started = false, stopping = false, failed = false, child, close;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function stop() {
  if (stopping) return; stopping = true;
  try {
    if (close) await close();
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill(name === 'postgres' ? 'SIGINT' : 'SIGTERM');
      for (let i = 0; i < 100 && child.exitCode === null && child.signalCode === null; i++) await delay(100);
      if (child.exitCode === null && child.signalCode === null) throw new Error('Stop deadline');
    }
    process.exit(failed ? 1 : 0);
  } catch { process.stderr.write('Owned worker stop incomplete; explicit recovery required.\n'); process.exitCode = 1; }
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, stop);
process.on('disconnect', () => { if (!started) process.exit(0); });
process.once('message', async config => {
  started = true;
  try {
    const m = o.load(id);
    if (!m.processes.some(p => p.name === name && p.pid === process.pid && p.identity === o.identity(process.pid))) throw new Error('Worker not receipted');
    if (['postgres', 'moto'].includes(name)) {
      const args = name === 'postgres' ? ['-D', path.join(m.root, 'postgres'), '-h', '127.0.0.1', '-p', String(m.ports.postgres), '-k', '', '-c', 'unix_socket_directories='] : ['-H', '127.0.0.1', '-p', String(m.ports.moto)];
      child = spawn(config.executable, args, { env: process.env, cwd: name === 'moto' ? path.join(m.root, 'moto') : m.root, stdio: name === 'postgres' ? ['ignore', 'ignore', 2] : 'ignore' });
      await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
      const receipt = { pid: child.pid, identity: o.identity(child.pid) };
      const content = JSON.stringify(receipt);
      o.atomic(path.join(o.base, 'control', `${id}-${name}.json`), content);
      o.atomic(path.join(m.root, 'logs', `${name}-process.json`), content);
      child.once('exit', () => { if (!stopping) process.exit(1); });
    } else if (name === 'api') {
      close = await require('./services.cjs').api(m);
      process.on('SIGUSR2', () => { void close.reconcile().catch(() => {}); });
    }
    else if (name === 'idp') {
      const { startFakeIdp } = await import(path.join(o.root, 'packages/fake-idp/dist/index.js'));
      const app = `http://127.0.0.1:${m.ports.web}`;
      const idp = await startFakeIdp({ port: m.ports.idp, clientId: 'e2e-client', redirectUris: [app + '/auth/callback'], logoutUris: [app + '/signed-out'] }); close = () => idp.stop();
    } else if (name === 'web') {
      const req = require('node:module').createRequire(path.join(o.root, 'apps/frontend/package.json'));
      const { preview } = await import(req.resolve('vite'));
      const server = await preview({ root: path.join(o.root, 'apps/frontend'), configFile: false, envFile: false, build: { outDir: 'dist-storage-e2e' }, preview: { host: '127.0.0.1', port: m.ports.web, strictPort: true } });
      close = () => new Promise((resolve, reject) => { server.httpServer.closeAllConnections(); server.httpServer.close(e => e ? reject(e) : resolve()); });
    } else throw new Error('Unknown service');
    process.send?.({ ready: true });
  } catch (error) { failed = true; process.stderr.write('Owned worker startup refused: ' + error.name + ' ' + (error.code || '') + '\n' + String(error.stack).split('\n').slice(1, 5).join('\n') + '\n'); await stop(); process.exit(1); }
});
setTimeout(() => { if (!started) process.exit(1); }, 10000).unref();
