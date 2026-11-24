// Local synthetic runtime only. A sealed control copy, directory inode and process start
// identity must agree before any signal or removal. Names/ports alone never prove ownership.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const net = require('node:net');
const root = path.resolve(__dirname, '../..');
const base = path.join(root, '.local-storage');
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const names = ['postgres', 'moto', 'api', 'idp', 'web'];
function refuse() { throw new Error('Local ownership verification refused; resources retained.'); }
function privateDir(dir) {
  const s = fs.lstatSync(dir);
  if (!s.isDirectory() || s.isSymbolicLink() || s.uid !== process.getuid() || (s.mode & 0o777) !== 0o700) refuse();
  return { dev: s.dev, ino: s.ino };
}
function ensureBase() {
  for (const dir of [base, path.join(base, 'runs'), path.join(base, 'control')]) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { mode: 0o700 });
    privateDir(dir);
  }
}
function atomic(file, data) {
  const temp = file + '.' + crypto.randomUUID();
  const fd = fs.openSync(temp, 'wx', 0o600);
  let renamed = false;
  try {
    try { fs.writeFileSync(fd, data); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temp, file); renamed = true;
    const dir = fs.openSync(path.dirname(file), 'r');
    try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
  } catch (error) {
    // Only the exclusive temporary created by this call; never remove the destination.
    if (!renamed) {
      try { fs.unlinkSync(temp); }
      catch (cleanup) { if (cleanup.code !== 'ENOENT') throw new AggregateError([error, cleanup], 'Owned atomic write cleanup failed.'); }
    }
    throw error;
  }
}
function read(file, limit = 262144) {
  const s = fs.lstatSync(file);
  if (!s.isFile() || s.isSymbolicLink() || s.uid !== process.getuid() || (s.mode & 0o777) !== 0o600 || s.size > limit) refuse();
  return fs.readFileSync(file, 'utf8');
}
function location(id) { if (!uuid.test(id)) refuse(); return path.join(base, 'runs', id); }
function control(id) { location(id); return path.join(base, 'control', id + '.json'); }
// The start of a process as the kernel counts it: clock ticks since boot, /proc/PID/stat field 22. On Linux, ps's lstart
// is these ticks added to the kernel's boot time, which moves when the wall clock is stepped (time sync on a fresh VM),
// so a recorded lstart can stop matching a process that never changed. The command name may hold spaces and ')'.
function procStart(text) {
  const close = text.lastIndexOf(')');
  const fields = close < 0 ? [] : text.slice(close + 2).trim().split(' ');
  if (fields.length < 20 || !/^\d+$/.test(fields[19])) refuse();
  return fields[19];
}
function identity(pid) {
  if (!Number.isSafeInteger(pid) || pid < 2) refuse();
  const linux = process.platform === 'linux';
  try {
    const result = execFileSync('ps', ['-p', String(pid), '-o', 'stat=', ...(linux ? [] : ['-o', 'lstart=']), '-o', 'command='], { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const match = /^(\S+)\s+(.+)$/.exec(result);
    if (!match || /^[ZX]/.test(match[1])) return null;
    if (!linux) return match[2];
    let stat;
    try { stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8'); } catch (e) { if (e.code === 'ENOENT' || e.code === 'ESRCH') return null; throw e; }
    return 'start-ticks:' + procStart(stat) + ' ' + match[2];
  } catch (e) { if (e.status === 1) return null; throw e; }
}
// An identity is its start (Linux: start-ticks:N; elsewhere ps's 24-character lstart), a space, then the command.
function identityParts(id) {
  const cut = id.startsWith('start-ticks:') ? id.indexOf(' ') : 24;
  return cut < 0 ? [id, ''] : [id.slice(0, cut), id.slice(cut + 1)];
}
function seal(m) {
  ensureBase();
  const content = JSON.stringify(m, null, 2) + '\n';
  // The independently stored control copy is never inferred from names in a supplied manifest.
  atomic(control(m.id), content);
  if (m.phase !== 'removed') atomic(path.join(location(m.id), 'manifest.json'), content);
}
function validate(m) {
  if (m.schema !== 1 || m.synthetic !== true || !uuid.test(m.id) || m.root !== location(m.id) || m.clinicalProcessing !== 'disabled' || m.host !== '127.0.0.1') refuse();
  if (m.database !== 'synthetic_storage_' + m.id.replaceAll('-', '') || m.bucket !== 'synthetic-storage-' + m.id || m.role !== 'storage_app') refuse();
  if (!['preparing', 'ready', 'stopping', 'failed', 'removed'].includes(m.phase)) refuse();
  if (names.some(n => !Number.isInteger(m.ports[n]) || m.ports[n] < 1024 || m.ports[n] > 65535) || new Set(Object.values(m.ports)).size !== 5) refuse();
  if (!Array.isArray(m.processes) || m.processes.length > 5) refuse();
  for (const p of m.processes) {
    if (!names.includes(p.name) || typeof p.identity !== 'string' || !p.identity.includes(path.join(__dirname, 'worker.cjs') + ' ' + m.id + ' ' + p.name)) refuse();
  }
  return m;
}
function load(id) {
  ensureBase();
  const text = read(control(id)); const m = validate(JSON.parse(text));
  if (m.id !== id) refuse();
  if (m.phase === 'removed') { if (fs.existsSync(m.root)) refuse(); return m; }
  const stat = privateDir(m.root);
  if (stat.dev !== m.directory.dev || stat.ino !== m.directory.ino || read(path.join(m.root, 'manifest.json')) !== text) refuse();
  const allowed = new Set(['manifest.json', 'postgres', 'moto', 'tmp', 'stage', 'logs', 'multipart.json', 'sweeps.json', 'clock.json', 'blast-radius.md']);
  if (fs.readdirSync(m.root).some(n => !allowed.has(n))) refuse();
  return m;
}
function live(p) {
  const current = identity(p.pid);
  if (current && current !== p.identity) {
    const [start, command] = identityParts(current), [savedStart, savedCommand] = identityParts(String(p.identity));
    const which = [start !== savedStart && 'start', command !== savedCommand && 'command'].filter(Boolean).join(', ') || 'start, command';
    throw new Error(`Local process identity mismatch (${which}); resources retained.`);
  }
  return !!current;
}
async function free(port) {
  await new Promise((resolve, reject) => {
    const server = net.createServer(); server.once('error', () => reject(new Error('Occupied local port; no service was contacted or stopped.')));
    server.listen({ host: '127.0.0.1', port, exclusive: true }, () => server.close(resolve));
  });
}
// A running owned PostgreSQL deletes its own files at any moment (temporary relations, relcache init files).
// The pre-signal check passes live: true and skips only an entry that vanished between readdir and lstat:
// nothing is left there to remove. Every entry still present is checked in full, and remove() repeats the
// strict check after every owned process has stopped, before any byte is deleted.
function checkTree(dir, { live = false } = {}, nested = false) {
  let entries;
  try { entries = fs.readdirSync(dir); } catch (e) { if (live && nested && e.code === 'ENOENT') return; throw e; }
  for (const name of entries) {
    const file = path.join(dir, name); let s;
    try { s = fs.lstatSync(file); } catch (e) { if (live && e.code === 'ENOENT') continue; throw e; }
    if (s.isSymbolicLink() || s.uid !== process.getuid() || (!s.isDirectory() && !s.isFile())) refuse();
    if (s.isDirectory()) checkTree(file, { live }, true);
  }
}
function remove(m) {
  load(m.id); if (m.processes.some(live)) refuse();
  checkTree(m.root);
  fs.rmSync(m.root, { recursive: true });
  m.phase = 'removed'; m.removedAt = new Date().toISOString(); seal(m);
}
class OperationBusyError extends Error {
  constructor() { super('Owned operation in progress; retry after it completes.'); this.name = 'OperationBusyError'; }
}
function lock(id) {
  location(id);
  const file = path.join(base, 'control', id + '.lock');
  const temp = file + '.' + crypto.randomUUID();
  const fd = fs.openSync(temp, 'wx', 0o600);
  try {
    try { fs.writeFileSync(fd, JSON.stringify({ pid: process.pid })); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const saved = JSON.parse(read(file));
        if (identity(saved.pid)) throw new OperationBusyError();
        fs.unlinkSync(file);
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      // Publish a complete receipt without replacing another holder. Readers
      // never see an empty lock; release/acquire races retry rather than fail health.
      try { fs.linkSync(temp, file); return () => fs.unlinkSync(file); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
    }
    throw new OperationBusyError();
  } finally {
    fs.unlinkSync(temp);
  }
}
module.exports = { root, base, names, uuid, ensureBase, location, privateDir, atomic, read, identity, procStart, seal, load, validate, live, free, checkTree, remove, lock, OperationBusyError };
