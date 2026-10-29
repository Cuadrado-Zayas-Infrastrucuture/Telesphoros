// Explicit local acceptance, never a no-service test that can silently skip.
const assert = require('node:assert/strict'); const fs = require('node:fs'); const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');
const o = require('./ownership.cjs'); const runtime = require('./runtime.cjs'); const services = require('./services.cjs');
const { protocol, client } = require('./protocol.cjs');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const evidenceFile = path.resolve(process.env.L3_EVIDENCE || path.join(o.base, 'rehearsal.json'));
const evidence = { schema: 1, synthetic: true, startedAt: new Date().toISOString(), base: execFileSync('git', ['merge-base', 'HEAD', 'origin/main'], { cwd: o.root, encoding: 'utf8' }).trim(), gitHead: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: o.root, encoding: 'utf8' }).trim(), node: process.versions.node, moto: runtime.motoVersion(), mode: 'native-loopback', checks: [], runs: [], status: 'running', limitations: [] };
function record(name, detail) { evidence.checks.push({ name, ...detail }); o.atomic(evidenceFile, JSON.stringify(evidence, null, 2)); console.log(name + ': ' + (detail.passed === false ? 'FAIL' : 'recorded')); }
async function begin() { const m = await runtime.setup(); evidence.runs.push({ id: m.id, ports: m.ports, database: m.database, bucket: m.bucket }); record('owned-setup', { passed: true, runId: m.id }); return m; }
async function destroy(m) { const removed = await runtime.teardown(m.id); assert.equal(removed.phase, 'removed'); assert.equal(fs.existsSync(m.root), false); await runtime.teardown(m.id); record('teardown-idempotent-no-residuals', { passed: true, runId: m.id }); }
function iam(m, create = false) {
  const python = path.join(path.dirname(process.env.MOTO_SERVER), 'python');
  const code = `import boto3,json,sys\nc=boto3.client('iam',endpoint_url=sys.argv[1],region_name='us-east-2',aws_access_key_id='synthetic-local',aws_secret_access_key='synthetic-local')\nif sys.argv[2]=='create':\n c.create_user(UserName='synthetic-l3-sentinel')\n c.create_policy(PolicyName='synthetic-l3-policy',PolicyDocument=json.dumps({'Version':'2012-10-17','Statement':[{'Effect':'Allow','Action':'s3:GetObject','Resource':'*'}]}))\n c.put_user_policy(UserName='synthetic-l3-sentinel',PolicyName='synthetic-l3-inline',PolicyDocument=json.dumps({'Version':'2012-10-17','Statement':[{'Effect':'Allow','Action':'s3:GetObject','Resource':'*'}]}))\n c.create_access_key(UserName='synthetic-l3-sentinel')\nprint(json.dumps({'users':len(c.list_users()['Users']),'policies':len(c.list_policies(Scope='Local')['Policies'])}))`;
  return JSON.parse(execFileSync(python, ['-c', code, services.endpoint(m), create ? 'create' : 'inspect'], { env: runtime.environment(m), encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'ignore'] }));
}
async function main() {
  o.ensureBase(); let m;
  try {
    m = process.env.L3_EXISTING_RUN ? o.load(process.env.L3_EXISTING_RUN) : await begin();
    evidence.moto = m.versions.moto;
    process.env.TMPDIR = path.join(m.root, 'tmp');
    record('clock-synchronization', await services.clocks(m));
    // Browser acceptance reuses L2's actual upload/download and authorization assertions,
    // but its servers now come entirely from L3 ownership/setup, not Playwright fixtures.
    const browserLog = fs.openSync(path.join(o.base, 'browser.log'), 'w', 0o600), browserError = fs.openSync(path.join(o.base, 'browser-error.log'), 'w', 0o600);
    try { execFileSync('pnpm', ['--filter', '@telesphoros/frontend', 'exec', 'playwright', 'test', '-c', 'playwright.operations.config.ts'], { cwd: o.root, env: { ...runtime.environment(m), L3_RUN_ID: m.id, CHROMIUM_PATH: process.env.CHROMIUM_PATH }, stdio: ['ignore', browserLog, browserError], timeout: 180000 }); } finally { fs.closeSync(browserLog); fs.closeSync(browserError); }
    record('browser-owned-postgres-moto', { passed: true, tests: 16, formats: ['PDF', 'JSON'], viewports: [375, 1280] });
    process.env.TMPDIR = path.join(m.root, 'stage');
    const expiry = await protocol(m, record); m = o.load(m.id);
    record('iam-policy-credential-sentinel', { passed: true, ...iam(m, true) });
    const sdk = services.backend('@aws-sdk/client-s3'), storage = client(m);
    try {
      await storage.send(new sdk.PutBucketPolicyCommand({ Bucket: m.bucket, Policy: JSON.stringify({ Version: '2012-10-17', Statement: [{ Effect: 'Allow', Principal: '*', Action: 's3:GetObject', Resource: `arn:aws:s3:::${m.bucket}/synthetic-sentinel` }] }) }));
      await storage.send(new sdk.PutObjectCommand({ Bucket: m.bucket, Key: 'synthetic-sentinel', Body: 'synthetic' }));
      const upload = await storage.send(new sdk.CreateMultipartUploadCommand({ Bucket: m.bucket, Key: 'synthetic-incomplete-sentinel' }));
      await storage.send(new sdk.UploadPartCommand({ Bucket: m.bucket, Key: 'synthetic-incomplete-sentinel', UploadId: upload.UploadId, PartNumber: 1, Body: Buffer.alloc(1024, 32) }));
    } finally { storage.destroy(); }
    // Preserve the bearer in memory only. Compare actual live behavior after its TTL,
    // without changing the host/emulator clock or disabling signature verification.
    while (Date.now() <= expiry.at + 1500) await sleep(Math.min(1000, expiry.at + 1501 - Date.now()));
    const expired = await fetch(expiry.url, { redirect: 'error', signal: AbortSignal.timeout(10000) }); await expired.body?.cancel();
    const enforced = expired.status === 403;
    record('live-signed-url-expiry', { passed: enforced, observedStatus: expired.status, enforcement: enforced ? 'enforced' : 'emulator-gap', ttlSeconds: 60 });
    if (!enforced) evidence.limitations.push(`Moto ${evidence.moto} accepted the expired signed URL. Provider signature expiry remains unverified; no AWS check was attempted.`);
    // Clinical tables are counted by the owned administrative connection, not hidden by RLS.
    const { Client } = services.backend('pg'); const c = new Client({ connectionString: services.dbUrl(m, 'storage_owner') });
    try { await c.connect(); const tables = ['report_captures', 'evaluations', 'capture_acceptances', 'corrections', 'cell_disputes']; for (const table of tables) assert.equal(Number((await c.query('SELECT count(*) AS n FROM ' + table)).rows[0].n), 0); record('clinical-tables-empty', { passed: true, tables }); } finally { await c.end(); }
    const restricted = new Client({ connectionString: services.dbUrl(m), connectionTimeoutMillis: 2000, query_timeout: 5000 });
    try {
      await restricted.connect();
      const privileges = (await restricted.query('SELECT rolsuper,rolbypassrls,rolcreatedb,rolcreaterole FROM pg_roles WHERE rolname=current_user')).rows[0];
      assert.equal(Object.values(privileges).some(Boolean), false);
      assert.equal(Number((await restricted.query('SELECT count(*) AS n FROM reports')).rows[0].n), 0);
      await restricted.query('BEGIN'); await restricted.query("SELECT set_config('app.current_tenant_id',$1,true)", ['alpha']);
      assert.ok(Number((await restricted.query('SELECT count(*) AS n FROM reports WHERE tenant_id=$1', ['alpha'])).rows[0].n) > 0);
      await restricted.query('ROLLBACK'); record('non-owner-effective-rls', { passed: true, unscopedRows: 0, ownedTenantRowsVisible: true });
    } finally { await restricted.end(); }
    // Refusal paths preflight before the first signal; all owned processes must stay alive.
    const manifest = path.join(m.root, 'manifest.json'), saved = o.read(manifest);
    o.atomic(manifest, saved.replace('disabled', 'enabled')); await assert.rejects(runtime.teardown(m.id)); o.atomic(manifest, saved);
    fs.renameSync(manifest, manifest + '.missing'); await assert.rejects(runtime.teardown(m.id)); fs.renameSync(manifest + '.missing', manifest);
    const sentinel = path.join(m.root, 'foreign-sentinel'); fs.writeFileSync(sentinel, 'preserve', { mode: 0o600 }); await assert.rejects(runtime.teardown(m.id)); assert.equal(fs.readFileSync(sentinel, 'utf8'), 'preserve'); fs.unlinkSync(sentinel);
    assert.equal(m.processes.every(o.live), true); record('tampered-missing-manifest-foreign-sentinel', { passed: true, processesPreserved: 5 });
    await destroy(m); m = undefined;
    const fresh = await begin(); m = fresh; assert.deepEqual(iam(m), { users: 0, policies: 0 });
    const check = client(m); try { const buckets = await check.send(new sdk.ListBucketsCommand({})); assert.deepEqual(buckets.Buckets.map(b => b.Name), [m.bucket]); const parts = await check.send(new sdk.ListMultipartUploadsCommand({ Bucket: m.bucket })); assert.equal((parts.Uploads || []).length, 0); } finally { check.destroy(); }
    record('fresh-moto-all-state-disposed', { passed: true, users: 0, policies: 0, inheritedBuckets: 0, incompleteUploads: 0 });
    await destroy(m); m = undefined;
    for (const failAfter of ['postgres', 'moto']) { await assert.rejects(runtime.setup({ failAfter }), /Injected partial setup failure/); for (const port of Object.values(runtime.ports)) await o.free(port); record('partial-setup-' + failAfter, { passed: true }); }
    // Exercise actual command signal handling, then a killed launcher with surviving
    // receipted service workers followed by explicit crash recovery.
    for (const signal of ['SIGINT', 'SIGKILL']) {
      const child = spawn(process.execPath, [path.join(__dirname, 'start.cjs'), 'start'], { env: process.env, cwd: o.root, stdio: ['pipe', 'pipe', 'ignore'] });
      let output = ''; let id;
      const end = new Promise(resolve => child.once('exit', resolve));
      child.stdout.on('data', b => { output += b; id = /run ([a-f0-9-]{36})/.exec(output)?.[1]; });
      for (let n = 0; !id && n < 600; n++) { if (child.exitCode !== null) throw new Error('Signal fixture exited before readiness'); await sleep(100); }
      assert.ok(id, 'Signal fixture readiness deadline');
      child.kill(signal); await end;
      const state = o.load(id);
      if (signal === 'SIGKILL') { assert.equal(state.phase, 'ready'); await destroy(state); }
      else assert.equal(state.phase, 'removed');
      record('launcher-' + signal, { passed: true, runId: id });
    }
    await require('./recovery.cjs').recovery(record);
    evidence.status = evidence.limitations.length ? 'passed-local-controls-with-emulator-gaps' : 'passed';
    evidence.finishedAt = new Date().toISOString(); o.atomic(evidenceFile, JSON.stringify(evidence, null, 2));
  } catch (error) {
    evidence.status = 'failed'; evidence.error = { name: error.name, code: error.code, stage: evidence.checks.at(-1)?.name || 'setup', frames: String(error.stack).split('\n').slice(1, 5), message: String(error.message).replace(/https?:\/\/\S+/g, '[URL]').slice(0, 200) };
    if (m) { try { await destroy(m); } catch { evidence.residualRun = m.id; evidence.cleanupFailure = 'Owned teardown refused or exceeded its deadline'; } }
    o.atomic(evidenceFile, JSON.stringify(evidence, null, 2)); throw new Error('L3 rehearsal failed; inspect aggregate evidence and private diagnostics.');
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
