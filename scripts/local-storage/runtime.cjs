const fs = require('node:fs'); const path = require('node:path');
const { randomUUID } = require('node:crypto'); const { fork, execFileSync } = require('node:child_process');
const o = require('./ownership.cjs');
const s = require('./services.cjs');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const ports = { postgres: 54481, moto: 5557, api: 3010, idp: 4010, web: 4173 };
function environment(m) {
  return { PATH: process.env.PATH, LC_ALL: 'C', TMPDIR: path.join(m.root, 'tmp'), PYTHONUNBUFFERED: '1', NODE_ENV: 'development', LAB_REPORT_PIPELINE: 'disabled', AWS_EC2_METADATA_DISABLED: 'true', AWS_ACCESS_KEY_ID: 'synthetic-local', AWS_SECRET_ACCESS_KEY: 'synthetic-local', AWS_DEFAULT_REGION: 'us-east-2', MOTO_ALLOW_NONEXISTENT_REGION: 'false', MOTO_DISABLE_GLOBAL_CORS: 'true' };
}
function configuration() {
  if (process.env.NODE_ENV === 'production' || (process.env.LAB_REPORT_PIPELINE && process.env.LAB_REPORT_PIPELINE !== 'disabled') || process.env.S3_UPLOAD_PART_MIN_SIZE) throw new Error('Storage-only mode or multipart limits refused.');
  const pg = process.env.LOCAL_PG_BIN; const moto = process.env.MOTO_SERVER;
  if (!pg || !path.isAbsolute(pg) || !moto || !path.isAbsolute(moto)) throw new Error('Explicit absolute LOCAL_PG_BIN and MOTO_SERVER required.');
  if (!/\b16\./.test(execFileSync(path.join(pg, 'postgres'), ['--version'], { encoding: 'utf8' }))) throw new Error('PostgreSQL 16 required.');
  // Pin the emulator package using its own Python runtime, not a different PATH install.
  const python = path.join(path.dirname(moto), 'python');
  if (execFileSync(python, ['-c', 'import importlib.metadata; print(importlib.metadata.version("moto"))'], { encoding: 'utf8' }).trim() !== '5.2.3') throw new Error('Moto 5.2.3 required.');
  if (Number(process.versions.node.split('.')[0]) !== 22) throw new Error('Node 22 required.');
  return { pg, moto };
}
function blast(m) {
  return `# Written teardown blast-radius check\n\nRun ${m.id}; synthetic only.\n\nExact removal boundary: ${m.root}\nDatabase ${m.database}, role ${m.role}, and all cluster roles live only inside ${m.root}/postgres.\nMoto bucket ${m.bucket}, IAM/policies, multipart parts and objects live only in this owned process and ${m.root}/moto.\nPorts: ${JSON.stringify(m.ports)} on 127.0.0.1. These are refusal checks, never kill targets.\n\nTeardown validates the control copy, root inode, private permissions and every PID/start identity before signaling. It stops the owned API/scheduler before IDP/web/Moto/PostgreSQL. It then removes this exact run directory, including all synthetic bytes, database/roles and staging. No shared-cluster DROP, AWS request, blanket prune or wildcard deletion. Existing review services and any foreign listener or sentinel are protected by refusal.\n\nLoss: all synthetic run data. Recovery: run setup with a new UUID and replay synthetic fixtures. This is full disposable-stack teardown, not pin-preserving orphan sweeping. Process mismatch, unexpected file, symlink or residual listener leaves resources for inspection and returns failure. Aggregate evidence and the control tombstone survive outside the removal boundary.\n`;
}
async function launch(m, name, executable) {
  const log = fs.openSync(path.join(m.root, 'logs', name + '.log'), 'a', 0o600);
  const child = fork(path.join(__dirname, 'worker.cjs'), [m.id, name], { env: { ...environment(m), TMPDIR: path.join(m.root, name === 'api' ? 'stage' : 'tmp') }, cwd: m.root, detached: true, stdio: ['ignore', log, log, 'ipc'] }); fs.closeSync(log);
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  const p = { name, pid: child.pid, identity: o.identity(child.pid) };
  m.processes.push(p); o.seal(m);
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Owned service startup deadline')), 45000);
    child.once('message', () => { clearTimeout(timer); resolve(); });
    child.once('exit', () => { clearTimeout(timer); reject(new Error('Owned service exited: ' + name)); });
  });
  child.send({ executable }); await ready; child.disconnect(); child.unref();
  return p;
}
function listener(m, name) {
  const p = ['postgres', 'moto'].includes(name) ? childReceipt(m, name) : m.processes.find(p => p.name === name);
  if (!p || !o.live(p)) return false;
  try { return execFileSync('lsof', ['-nP', '-a', '-p', String(p.pid), '-iTCP:' + m.ports[name], '-sTCP:LISTEN', '-F', 'n'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split('\n').includes('n127.0.0.1:' + m.ports[name]); } catch (e) { if (e.status === 1) return false; throw e; }
}
async function ready(m, name) {
  for (let n = 0; n < 100; n++) {
    if (!o.live(m.processes.find(p => p.name === name))) throw new Error('Owned service exited: ' + name);
    try {
      if (!listener(m, name)) { await delay(100); continue; }
      if (name === 'postgres') {
        const { Client } = s.backend('pg'); const c = new Client({ connectionString: s.dbUrl(m, 'storage_owner', 'postgres'), connectionTimeoutMillis: 500 });
        try { await c.connect(); const dir = (await c.query('SHOW data_directory')).rows[0].data_directory; if (dir !== path.join(m.root, 'postgres')) throw new Error('Foreign database'); return; } finally { await c.end(); }
      }
      const url = name === 'moto' ? s.endpoint(m) + '/moto-api/' : name === 'api' ? `http://127.0.0.1:${m.ports.api}/api/v1/health` : name === 'idp' ? `http://127.0.0.1:${m.ports.idp}/.well-known/openid-configuration` : `http://127.0.0.1:${m.ports.web}`;
      if ((await fetch(url, { signal: AbortSignal.timeout(500), redirect: 'error', headers: { Connection: 'close' } })).ok) return;
    } catch { /* Still starting: bounded and receipted. */ }
    await delay(100);
  }
  throw new Error('Owned readiness deadline');
}
async function setup({ failAfter } = {}) {
  const config = configuration(); o.ensureBase();
  for (const port of Object.values(ports)) await o.free(port);
  const id = randomUUID(); const dir = o.location(id); fs.mkdirSync(dir, { mode: 0o700 });
  const m = { schema: 1, synthetic: true, id, root: dir, directory: o.privateDir(dir), host: '127.0.0.1', ports, database: 'synthetic_storage_' + id.replaceAll('-', ''), role: 'storage_app', bucket: 'synthetic-storage-' + id, clinicalProcessing: 'disabled', phase: 'preparing', createdAt: new Date().toISOString(), processes: [], gitHead: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: o.root, encoding: 'utf8' }).trim(), versions: { node: process.versions.node, moto: '5.2.3', postgres: '16' } };
  o.seal(m);
  for (const name of ['moto', 'tmp', 'stage', 'logs']) fs.mkdirSync(path.join(dir, name), { mode: 0o700 });
  s.saveMultipart(m, []); o.atomic(path.join(dir, 'blast-radius.md'), blast(m));
  try {
    execFileSync(path.join(config.pg, 'initdb'), ['-D', path.join(dir, 'postgres'), '-U', 'storage_owner', '--encoding=UTF8', '--locale=C', '--auth=trust'], { env: environment(m), stdio: 'ignore', timeout: 30000 });
    await launch(m, 'postgres', path.join(config.pg, 'postgres')); await ready(m, 'postgres');
    if (failAfter === 'postgres') throw new Error('Injected partial setup failure');
    const { Client } = s.backend('pg'); const admin = new Client({ connectionString: s.dbUrl(m, 'storage_owner', 'postgres'), connectionTimeoutMillis: 2000, query_timeout: 10000 });
    try { await admin.connect(); /* Identifiers are derived exclusively from a generated UUID. */ await admin.query('CREATE DATABASE "' + m.database + '"'); } finally { await admin.end(); }
    const owner = new Client({ connectionString: s.dbUrl(m, 'storage_owner'), connectionTimeoutMillis: 2000, query_timeout: 10000 });
    try { await owner.connect(); await s.dist('db/migrator').migrateUp(owner); await owner.query('CREATE ROLE storage_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOBYPASSRLS'); await owner.query('GRANT telesphoros_app TO storage_app');  } finally { await owner.end(); }
    const app = new Client({ connectionString: s.dbUrl(m), connectionTimeoutMillis: 2000, query_timeout: 10000 });
    try { await app.connect(); const r = (await app.query('SELECT rolsuper, rolbypassrls, rolcreatedb, rolcreaterole FROM pg_roles WHERE rolname=current_user')).rows[0]; if (Object.values(r).some(Boolean)) throw new Error('Unsafe application role'); const acl = (await app.query("SELECT has_table_privilege(current_user,'report_upload_attempts','SELECT') AND has_table_privilege(current_user,'report_upload_attempts','INSERT') AND has_table_privilege(current_user,'report_upload_attempts','UPDATE') AS ok")).rows[0]; if (!acl.ok) throw new Error('Application journal privileges missing'); } finally { await app.end(); }
    await launch(m, 'moto', config.moto); await ready(m, 'moto');
    const sdk = s.backend('@aws-sdk/client-s3'); const client = new sdk.S3Client({ endpoint: s.endpoint(m), region: 'us-east-2', forcePathStyle: true, credentials: { accessKeyId: 'synthetic-local', secretAccessKey: 'synthetic-local' }, maxAttempts: 1 });
    try {
      await client.send(new sdk.CreateBucketCommand({ Bucket: m.bucket, CreateBucketConfiguration: { LocationConstraint: 'us-east-2' } }));
      await client.send(new sdk.PutBucketVersioningCommand({ Bucket: m.bucket, VersioningConfiguration: { Status: 'Enabled' } }));
      await client.send(new sdk.PutBucketCorsCommand({ Bucket: m.bucket, CORSConfiguration: { CORSRules: [{ AllowedOrigins: [`http://127.0.0.1:${m.ports.web}`], AllowedMethods: ['GET', 'HEAD'], AllowedHeaders: ['*'], ExposeHeaders: ['Content-Length', 'ETag'] }] } }));
    } finally { client.destroy(); }
    if (failAfter === 'moto') throw new Error('Injected partial setup failure');
    for (const name of ['idp', 'api', 'web']) { await launch(m, name); await ready(m, name); }
    m.phase = 'ready'; o.seal(m); return m;
  } catch (error) {
    m.phase = 'failed'; o.seal(m);
    for (const name of o.names) { const f = path.join(m.root, 'logs', name + '.log'); if (fs.existsSync(f)) o.atomic(path.join(o.base, 'control', m.id + '-' + name + '-failure.log'), fs.readFileSync(f)); }
    try { await teardown(id); } catch { throw new Error(`Partial setup retained owned run ${id}; explicit teardown required.`); }
    throw error;
  }
}
function childReceipt(m, name) {
  const file = path.join(m.root, 'logs', name + '-process.json');
  if (!fs.existsSync(file)) return undefined;
  const text = o.read(file);
  if (text !== o.read(path.join(o.base, 'control', `${m.id}-${name}.json`))) throw new Error('Child receipt mismatch');
  const receipt = JSON.parse(text);
  if (name === 'moto') {
    // macOS Python re-execs its framework binary after spawn. Keep start identity
    // and the exact script/arguments pinned while permitting that interpreter-only change.
    const current = o.identity(receipt.pid);
    const pattern = /^(.*?\d{4})\s+\S+\s+(.+)$/;
    const before = pattern.exec(receipt.identity), after = current && pattern.exec(current);
    if (before && after && before[1] === after[1] && before[2] === after[2] && before[2].endsWith('moto_server -H 127.0.0.1 -p ' + m.ports.moto)) receipt.identity = current;
  }
  return receipt;
}
async function stop(p, signal = 'SIGTERM') {
  if (!o.live(p)) return;
  process.kill(p.pid, signal);
  const deadline = performance.now() + 45000;
  while (performance.now() < deadline) {
    const current = o.identity(p.pid); if (!current) return;
    // Darwin can expose '(node)' while exit is in progress. After the one
    // already-authorized signal, wait for disappearance; never signal this placeholder.
    const retiring = current.slice(0, 24) === p.identity.slice(0, 24) && /\s\([^()]+\)$/.test(current);
    if (current !== p.identity && !retiring) o.live(p);
    await delay(100);
  }
  throw new Error('Owned process stop deadline; retained for recovery.');
}
async function teardown(id) {
  const first = o.load(id); if (first.phase === 'removed') return first;
  const unlock = o.lock(id);
  try {
    const m = o.load(id);
    // Preflight the entire removal plan before the first signal; never partially clean a tampered run.
    for (const p of m.processes) { o.live(p); const c = ['postgres', 'moto'].includes(p.name) && childReceipt(m, p.name); if (c) o.live(c); }
    o.checkTree(m.root);
    m.phase = 'stopping'; o.seal(m);
    for (const name of ['api', 'web', 'idp', 'moto', 'postgres']) {
      const p = m.processes.find(p => p.name === name); if (!p) continue;
      await stop(p);
      const c = ['postgres', 'moto'].includes(name) && childReceipt(m, name);
      if (c) await stop(c, name === 'postgres' ? 'SIGINT' : 'SIGTERM');
    }
    for (const port of Object.values(m.ports)) await o.free(port);
    o.remove(m); return m;
  } finally { unlock(); }
}
async function restartApi(id) {
  const unlock = o.lock(id);
  try {
    const m = o.load(id); if (m.phase !== 'ready') throw new Error('Only a ready owned run can restart its API');
    const api = m.processes.find(p => p.name === 'api');
    await stop(api);
    m.processes = m.processes.filter(p => p.name !== 'api'); m.phase = 'preparing'; o.seal(m);
    await launch(m, 'api'); await ready(m, 'api'); m.phase = 'ready'; o.seal(m); return m;
  } finally { unlock(); }
}
function health(id) {
  let unlock;
  try { unlock = o.lock(id); }
  catch (error) { if (error instanceof o.OperationBusyError) return 'busy'; throw error; }
  try {
    // Read and inspect under the same lock used by restart/teardown. A monitor
    // cannot observe a stopped PID or half-written receipt during maintenance.
    const m = o.load(id);
    if (m.phase === 'removed') return 'removed';
    return m.phase === 'ready' && o.names.every(name => m.processes.some(p => p.name === name && o.live(p))) ? 'healthy' : 'unhealthy';
  } finally { unlock(); }
}
async function sweepNow(id) {
  const m = o.load(id); if (m.phase !== 'ready') throw new Error('Owned run is not ready');
  const worker = m.processes.find(p => p.name === 'api'); if (!worker || !o.live(worker)) throw new Error('Owned API worker unavailable');
  const file = path.join(m.root, 'sweeps.json'); const before = JSON.parse(o.read(file)).at(-1).sequence;
  process.kill(worker.pid, 'SIGUSR2');
  const deadline = performance.now() + 35000;
  while (performance.now() < deadline) {
    o.load(id); if (!o.live(worker)) throw new Error('Owned worker stopped');
    const result = JSON.parse(o.read(file)).at(-1);
    if (result.sequence > before) { if (!result.success) throw new Error('Reconciliation refused; API admission remains closed'); return result; }
    await delay(100);
  }
  throw new Error('Reconciliation deadline; inspect owned status');
}
module.exports = { setup, teardown, ports, environment, blast, childReceipt, stop, listener, restartApi, sweepNow, health };
