// Synthetic test fixture only. No production service is started.
// Capture the actual launcher/worker spawn paths in a VM, stubbing DB/startup
// ownership work; run the captured Moto child separately with real Chromium.
// Cleanup targets only mkdtemp-owned files and this fixture's child/server handles.
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { spawn, execFileSync } = require('node:child_process');
const http = require('node:http');
const { tmpdir } = require('node:os');

const repo = path.resolve(__dirname, '../..');
const fromBackend = createRequire(path.join(repo, 'apps/backend/package.json'));
const fromFrontend = createRequire(path.join(repo, 'apps/frontend/package.json'));
const sdk = fromBackend('@aws-sdk/client-s3');
const { getSignedUrl } = fromBackend('@aws-sdk/s3-request-presigner');
const { chromium } = fromFrontend('@playwright/test');
const parentCredential = 'synthetic-parent-must-not-inherit';
const canonical = value => JSON.parse(JSON.stringify(value));

function source(file, defect) {
  let text = fs.readFileSync(file, 'utf8');
  if (defect === 'remove-setting') {
    const setting = ", MOTO_DISABLE_GLOBAL_CORS: 'true'";
    assert.equal(text.split(setting).length, 2, 'one launcher setting to remove');
    text = text.replace(setting, '');
  }
  return text;
}
function evaluate(file, text, requireFn, processValue) {
  const module = { exports: {} };
  vm.runInNewContext(text, {
    module, exports: module.exports, require: requireFn,
    __dirname: path.dirname(file), __filename: file, process: processValue,
    setTimeout, clearTimeout, queueMicrotask, fetch: async () => ({ ok: true }),
    console: { log() {}, error() { throw new Error('Launcher capture refused'); } },
  }, { filename: file, timeout: 5000 });
  return module.exports;
}
function captureSdk(policies) {
  const fake = { S3Client: class {
    async send(command) {
      if (command.kind === 'PutBucketCorsCommand') policies.push(canonical(command.input.CORSConfiguration.CORSRules[0]));
      return {};
    }
    destroy() {}
  } };
  for (const kind of ['CreateBucketCommand', 'PutBucketVersioningCommand', 'PutBucketCorsCommand']) {
    fake[kind] = class { constructor(input) { this.kind = kind; this.input = input; } };
  }
  return fake;
}
function parent(root) {
  return { PATH: process.env.PATH, TMPDIR: root,
    MOTO_DISABLE_GLOBAL_CORS: 'false', AWS_ACCESS_KEY_ID: parentCredential };
}
async function captureOwned(root, webPort, motoPort, runtime, defect) {
  const policies = [], forks = [];
  const ownership = {
    root: repo, base: root, names: [], ensureBase() {}, seal() {},
    location: id => path.join(root, id), privateDir: () => ({}),
    identity: () => 'synthetic-capture-identity', free: async () => {},
    atomic: file => assert.ok(file.startsWith(root + path.sep)),
  };
  const storage = {
    backend: name => name === 'pg' ? { Client: class {
      async connect() {} async end() {}
      async query(sql) { return { rows: [sql.includes('has_table_privilege') ? { ok: true } : {
        rolsuper: false, rolbypassrls: false, rolcreatedb: false, rolcreaterole: false,
      }] }; }
    } } : captureSdk(policies),
    dist: () => ({ migrateUp: async () => {} }), seedPersonas: async () => {}, saveMultipart() {},
    dbUrl: () => 'postgresql://synthetic-capture@127.0.0.1/capture',
    endpoint: () => 'http://127.0.0.1:' + motoPort,
  };
  const file = path.join(repo, 'scripts/local-storage/runtime.cjs');
  const req = createRequire(file);
  const requireFn = name => {
    if (name === './ownership.cjs') return ownership;
    if (name === './services.cjs') return storage;
    if (name !== 'node:child_process') return req(name);
    return {
      execFileSync: (_bin, args) => args.includes('--version') ? 'PostgreSQL 16.0' :
        args.includes('-c') ? runtime.version : 'synthetic-capture',
      fork: (bin, args, options) => {
        const child = new EventEmitter(); child.pid = 100 + forks.length;
        child.disconnect = child.unref = () => {};
        child.send = message => { child.message = message; queueMicrotask(() => child.emit('message', {})); };
        forks.push({ bin, args, options, child });
        queueMicrotask(() => child.emit('spawn'));
        return child;
      },
    };
  };
  // Readiness/DB work is outside this fixture; launch itself remains the real code.
  const code = source(file, defect) + '\nready = async () => {}; ports.web = ' + webPort + '; ports.moto = ' + motoPort + ';';
  const mod = evaluate(file, code, requireFn, { env: { ...parent(root), LOCAL_PG_BIN: root, MOTO_SERVER: runtime.server }, versions: process.versions });
  const manifest = await mod.setup();
  assert.equal(manifest.versions.moto, runtime.version, 'manifest records the validated Moto version');
  assert.equal(policies.length, 1);
  const fork = forks.find(f => f.args[1] === 'moto');
  assert.ok(fork, 'actual owned runtime forks its Moto worker');

  const worker = path.join(repo, 'scripts/local-storage/worker.cjs');
  const callbacks = {}; let captured, ready = 0, receipts = 0;
  const workerProcess = {
    argv: [process.execPath, worker, manifest.id, 'moto'], pid: fork.child.pid, env: fork.options.env,
    on() {}, once: (event, fn) => { callbacks[event] = fn; },
    send: () => { ready++; }, exit() { throw new Error('Worker capture refused'); },
    stderr: { write() { throw new Error('Worker capture failed'); } },
  };
  const workerRequire = name => {
    if (name === './ownership.cjs') return {
      ...ownership, load: () => manifest, atomic: file => { ownership.atomic(file); receipts++; },
    };
    if (name === 'node:child_process') return { spawn: (bin, args, options) => {
      captured = { bin, args: Array.from(args), env: options.env, cwd: options.cwd };
      const child = new EventEmitter(); child.pid = 200;
      queueMicrotask(() => child.emit('spawn')); return child;
    } };
    return req(name);
  };
  let workerCode = fs.readFileSync(worker, 'utf8');
  if (defect === 'drop-worker-setting') {
    assert.ok(workerCode.includes('env: process.env'));
    workerCode = workerCode.replace('env: process.env', "env: Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== 'MOTO_DISABLE_GLOBAL_CORS'))");
  }
  // Its startup timer is stubbed; the actual message handler and spawn are exercised.
  const module = { exports: {} };
  vm.runInNewContext(workerCode, { module, require: workerRequire, process: workerProcess,
    __dirname: path.dirname(worker), setTimeout: () => ({ unref() {} }), queueMicrotask,
  }, { filename: worker, timeout: 5000 });
  await callbacks.message(fork.child.message);
  assert.equal(ready, 1); assert.equal(receipts, 2);
  assert.equal(captured.bin, runtime.server);
  assert.deepEqual(captured.args, ['-H', '127.0.0.1', '-p', String(motoPort)]);
  if (defect !== 'drop-worker-setting') assert.equal(captured.env, fork.options.env);
  return { ...captured, policy: policies[0], method: 'GET' };
}
async function captureReview(root, webPort, motoPort, runtime, defect) {
  const policies = [], children = [];
  const file = path.join(repo, 'scripts/local-review/start.cjs');
  const fakeSdk = captureSdk(policies);
  const requireFn = name => {
    if (name === 'node:child_process') return { spawn: (bin, args, options) => {
      children.push({ bin, args: Array.from(args), env: options.env, cwd: options.cwd });
      const child = new EventEmitter(); child.kill = () => {}; return child;
    } };
    if (name === 'node:module') return { createRequire: () => name => {
      assert.equal(name, '@aws-sdk/client-s3'); return fakeSdk;
    } };
    if (name === 'node:net') return { createServer: () => ({
      once() {}, listen(_port, host, done) { assert.equal(host, '127.0.0.1'); done(); }, close(done) { done(); },
    }) };
    return require(name);
  };
  evaluate(file, source(file, defect), requireFn, {
    argv: [process.execPath, file], execPath: process.execPath, versions: process.versions,
    env: { ...parent(root), LOCAL_REVIEW_WEB_PORT: String(webPort), LOCAL_REVIEW_MOTO_PORT: String(motoPort),
      LOCAL_MOTO_PYTHON: runtime.python },
    on() {}, exit() { throw new Error('Review launcher capture refused'); },
  });
  for (let i = 0; i < 1000 && children.length < 4; i++) await new Promise(r => setTimeout(r, 1));
  assert.equal(children.length, 4, 'actual review launch path completes');
  assert.equal(policies.length, 1);
  assert.equal(children[0].bin, runtime.python);
  assert.deepEqual(children[0].args, ['-m', 'moto.server', '-H', '127.0.0.1', '-p', String(motoPort)]);
  for (const child of children) assert.notEqual(child.env.AWS_ACCESS_KEY_ID, parentCredential);
  return { ...children[0], cwd: root, policy: policies[0], method: 'GET' };
}
function pythonRuntime() {
  const python = process.env.LOCAL_MOTO_PYTHON || 'python3';
  const code = 'import importlib.metadata,json,pathlib,sysconfig; print(json.dumps({"version":importlib.metadata.version("moto"),"server":str(pathlib.Path(sysconfig.get_path("scripts"))/"moto_server")}))';
  const runtime = JSON.parse(execFileSync(python, ['-c', code], { encoding: 'utf8', env: { PATH: process.env.PATH } }));
  assert.equal(runtime.version, require('./runtime.cjs').motoVersion(), 'use the repository pinned Moto');
  assert.ok(path.isAbsolute(runtime.server));
  return { ...runtime, python };
}
async function server() {
  const s = http.createServer((_req, res) => {
    res.setHeader('Content-Type', 'text/html'); res.setHeader('Cache-Control', 'no-store');
    res.end('<!doctype html><title>Synthetic CORS control</title>');
  });
  await new Promise((resolve, reject) => { s.once('error', reject); s.listen(0, '127.0.0.1', resolve); });
  return s;
}
const origin = s => 'http://127.0.0.1:' + s.address().port;
async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Owned Moto stop deadline')), 5000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
    child.kill('SIGTERM');
  });
}
async function verifyLauncher(kind, defect) {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'launcher-cors-'));
  const identity = fs.lstatSync(root);
  let web, other, browser, child, client;
  try {
    const runtime = pythonRuntime();
    web = await server(); other = await server();
    const portProbe = await server(); const motoPort = portProbe.address().port;
    await new Promise(resolve => portProbe.close(resolve));
    const capture = kind === 'owned' ? captureOwned : captureReview;
    const spec = await capture(root, web.address().port, motoPort, runtime, defect);
    // Independent expected policy: do not derive the oracle from the shared implementation contract.
    assert.deepEqual(spec.policy, { AllowedOrigins: [origin(web)], AllowedMethods: ['GET'],
      AllowedHeaders: ['Content-Type'], ExposeHeaders: ['ETag'], MaxAgeSeconds: 300 });
    assert.notEqual(spec.env.AWS_ACCESS_KEY_ID, parentCredential);
    let bound = false, startupFailed = false;
    child = spawn(spec.bin, spec.args, { env: spec.env, cwd: spec.cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    child.once('error', () => { startupFailed = true; });
    const binding = 'Running on http://127.0.0.1:' + motoPort;
    let startup = '';
    for (const stream of [child.stdout, child.stderr]) stream.on('data', data => {
      startup = (startup + data.toString()).slice(-4096); if (startup.includes(binding)) bound = true;
    });
    // Only contact the endpoint after this exact owned child reports its bind.
    for (let i = 0; i < 200 && !bound && !startupFailed && child.exitCode === null; i++) await new Promise(r => setTimeout(r, 50));
    assert.ok(bound && !startupFailed && child.exitCode === null, 'owned Moto bound its loopback listener');
    const endpoint = 'http://127.0.0.1:' + motoPort;
    client = new sdk.S3Client({ endpoint, region: 'us-east-2', forcePathStyle: true,
      credentials: { accessKeyId: 'synthetic', secretAccessKey: 'synthetic' }, maxAttempts: 1 });
    const send = command => client.send(command, { abortSignal: AbortSignal.timeout(5000) });
    const Bucket = 'synthetic-launcher-cors', Key = 'synthetic.json', bytes = '{"synthetic":true}';
    await send(new sdk.CreateBucketCommand({ Bucket, CreateBucketConfiguration: { LocationConstraint: 'us-east-2' } }));
    await send(new sdk.PutBucketVersioningCommand({ Bucket, VersioningConfiguration: { Status: 'Enabled' } }));
    const initial = await send(new sdk.PutObjectCommand({ Bucket, Key, Body: bytes, ContentType: 'application/json' }));
    const apply = async rule => {
      await send(new sdk.PutBucketCorsCommand({ Bucket, CORSConfiguration: { CORSRules: [rule] } }));
      assert.deepEqual((await send(new sdk.GetBucketCorsCommand({ Bucket }))).CORSRules, [rule]);
    };
    await apply(spec.policy);
    const command = new sdk.GetObjectCommand({ Bucket, Key, VersionId: initial.VersionId });
    const url = await getSignedUrl(client, command, { expiresIn: 300 });
    const getUrl = await getSignedUrl(client, new sdk.GetObjectCommand({ Bucket, Key, VersionId: initial.VersionId }), { expiresIn: 300 });
    const preflight = await fetch(getUrl, { method: 'OPTIONS', signal: AbortSignal.timeout(5000), headers: {
      Origin: origin(web), 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'Content-Type',
    } });
    assert.equal(preflight.status, 200);
    assert.equal(preflight.headers.get('access-control-allow-origin'), origin(web));
    assert.deepEqual((preflight.headers.get('access-control-allow-methods') || '').split(/,\s*/), ['GET']);
    const putPreflight = await fetch(getUrl, { method: 'OPTIONS', signal: AbortSignal.timeout(5000), headers: {
      Origin: origin(web), 'Access-Control-Request-Method': 'PUT', 'Access-Control-Request-Headers': 'Content-Type',
    } });
    assert.ok(!(putPreflight.headers.get('access-control-allow-methods') || '').split(/,\s*/).includes('PUT'));
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    page.setDefaultTimeout(5000);
    const request = async (requestUrl = url, method = spec.method) => page.evaluate(async ({ url, method, bytes }) => {
      try {
        const options = { method, credentials: 'omit', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(5000) };
        if (method === 'PUT') { options.headers = { 'Content-Type': 'application/json' }; options.body = bytes; }
        const response = await fetch(url, options);
        return { readable: true, ok: response.ok, text: await response.text() };
      } catch { return { readable: false }; }
    }, { url: requestUrl, method, bytes });
    const allowed = async () => {
      const result = await request(); assert.equal(result.readable, true); assert.equal(result.ok, true);
      assert.equal(result.text, bytes);
    };
    await page.goto(origin(web)); await allowed();
    assert.deepEqual(await request(getUrl, 'PUT'), { readable: false }, 'browser must refuse retired storage PUT');
    const allowedGet = async () => {
      const result = await request(getUrl, 'GET');
      assert.deepEqual(result, { readable: true, ok: true, text: bytes });
    };
    await allowedGet();
    await page.goto(origin(other));
    // Exercise simple GET too: a preflight refusal alone cannot detect Moto's global fallback.
    const refused = await request(getUrl, 'GET');
    if (refused.readable) {
      assert.equal(refused.ok, true, 'defect control must read a successful response');
      assert.equal(refused.text, bytes, 'defect control must read the exact pinned synthetic bytes');
      const error = new Error('Excluded real browser origin was admitted'); error.code = 'EXCLUDED_ORIGIN_ADMITTED'; throw error;
    }
    // Positive control: same live document and URL succeed when its origin is allowed.
    await apply({ ...spec.policy, AllowedOrigins: [origin(other)] }); await allowedGet();
    await apply(spec.policy); await page.goto(origin(web)); await allowedGet();
    assert.equal(spec.env.MOTO_DISABLE_GLOBAL_CORS, 'true', 'false parent cannot override child setting');
    return { kind, method: spec.method, policyReadback: true, approvedOrigin: true, excludedOrigin: true,
      sameDocumentPositiveControl: true, restoredPolicy: true, parentOverrideRefused: true };
  } finally {
    if (browser) await browser.close();
    if (client) client.destroy();
    for (const s of [web, other]) if (s) {
      s.closeAllConnections(); await new Promise(resolve => s.close(resolve));
    }
    await stopChild(child);
    const current = fs.lstatSync(root);
    assert.ok(current.isDirectory() && !current.isSymbolicLink());
    assert.equal(current.dev, identity.dev); assert.equal(current.ino, identity.ino);
    fs.rmSync(root, { recursive: true });
  }
}
module.exports = { verifyLauncher };
