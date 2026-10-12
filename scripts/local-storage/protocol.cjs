// Test-only local protocol writer. Never imported by the product runtime.
const assert = require('node:assert/strict'); const { randomUUID, createHash } = require('node:crypto');
const path = require('node:path'); const { Readable } = require('node:stream');
const o = require('./ownership.cjs'); const s = require('./services.cjs');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const ALICE = '11111111-1111-4111-8111-111111111111';
async function token(m, user = ALICE) {
  const verifier = randomUUID() + randomUUID();
  const idp = `http://127.0.0.1:${m.ports.idp}`, redirect = `http://127.0.0.1:${m.ports.web}/auth/callback`;
  const params = new URLSearchParams({ client_id: 'e2e-client', response_type: 'code', redirect_uri: redirect, code_challenge_method: 'S256', code_challenge: createHash('sha256').update(verifier).digest('base64url'), state: randomUUID() });
  // The existing fake provider accepts its own synthetic session cookie; PKCE and
  // the single-use authorization code still flow through its real endpoints.
  const response = await fetch(idp + '/oauth2/authorize?' + params, { headers: { Cookie: 'fake_idp_session=' + user, Connection: 'close' }, redirect: 'manual', signal: AbortSignal.timeout(5000) });
  assert.equal(response.status, 302);
  const code = new URL(response.headers.get('location')).searchParams.get('code');
  const reply = await fetch(idp + '/oauth2/token', { method: 'POST', body: new URLSearchParams({ grant_type: 'authorization_code', client_id: 'e2e-client', redirect_uri: redirect, code, code_verifier: verifier }), signal: AbortSignal.timeout(5000) });
  assert.equal(reply.status, 200); return (await reply.json()).access_token;
}
function client(m) {
  const sdk = s.backend('@aws-sdk/client-s3');
  return new sdk.S3Client({ endpoint: s.endpoint(m), region: 'us-east-2', forcePathStyle: true, credentials: { accessKeyId: 'synthetic-local', secretAccessKey: 'synthetic-local' }, maxAttempts: 1 });
}
async function protocol(m, record) {
  o.load(m.id); const bearer = await token(m); const sdk = s.backend('@aws-sdk/client-s3'); const storage = client(m);
  const { Database } = s.dist('db/database'); const { PostgresReportsRepository } = s.dist('storage/postgres/reports.repository');
  const db = new Database({ url: s.dbUrl(m), ssl: 'disable' }); const repo = new PostgresReportsRepository(db);
  const call = async (route, method = 'GET', body, status = 200, extra = {}) => {
    const response = await fetch(`http://127.0.0.1:${m.ports.api}/api/v1/${route}`, { method, headers: { Authorization: 'Bearer ' + bearer, ...(body ? { 'Content-Type': 'application/json' } : {}), ...extra }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30000) });
    assert.equal(response.status, status, `API ${method} ${route.replace(/[a-f0-9-]{36}/g, ':id')} status`);
    return response.status === 204 ? null : response.json();
  };
  const small = Buffer.from('%PDF-1.7\nSynthetic operational fixture\n%%EOF\n');
  const good = Buffer.alloc(6 * 1024 ** 2, 32); small.subarray(0, 9).copy(good); Buffer.from('\n%%EOF\n').copy(good, good.length - 7);
  async function attempt(bytes = good) {
    const patient = await call('patients', 'POST', { label: 'SYN-' + randomUUID() }, 201);
    const report = await call('reports', 'POST', { patientId: patient.id, type: 'lab-pdf', filename: 'synthetic-operations.pdf', sizeBytes: bytes.length }, 201);
    const state = await call(`reports/${report.id}/upload-state`);
    const a = await call(`reports/${report.id}/upload-attempts`, 'POST', { revision: state.revision, requestId: randomUUID(), contentType: 'application/pdf', sha256: sha(bytes) }, 201);
    const identity = { tenantId: 'alpha', principal: ALICE, reportId: report.id, id: a.attemptId, revision: a.revision };
    return { ...a, identity, row: await repo.findAttempt(identity), route: `reports/${report.id}/upload-attempts/${a.attemptId}`, header: { 'X-Upload-Revision': a.revision } };
  }
  async function start(a) {
    const writer = randomUUID(); assert.equal(await repo.beginAttempt(a.identity, writer), true);
    // Exactly the existing streaming validator; test transport faults are injected only AFTER this boundary.
    const staged = await s.dist('reports/intake/stage').stage(Readable.from([good]), 'lab-pdf', good.length, sha(good), AbortSignal.timeout(30000), m.id);
    try { assert.equal(await repo.validateAttempt(a.identity, writer), true); } finally { await staged.dispose(); }
    const UploadId = (await storage.send(new sdk.CreateMultipartUploadCommand({ Bucket: m.bucket, Key: a.row.key, ContentType: 'application/pdf', Metadata: { 'upload-run': m.id, 'upload-attempt': a.attemptId } }))).UploadId;
    const receipts = JSON.parse(o.read(path.join(m.root, 'multipart.json'))); receipts.push({ key: a.row.key, uploadId: UploadId }); s.saveMultipart(m, receipts);
    return { writer, UploadId, Bucket: m.bucket, Key: a.row.key };
  }
  const part = async (u, n, bytes) => ({ PartNumber: n, ETag: (await storage.send(new sdk.UploadPartCommand({ Bucket: u.Bucket, Key: u.Key, UploadId: u.UploadId, PartNumber: n, Body: bytes }))).ETag });
  const complete = (u, parts) => storage.send(new sdk.CompleteMultipartUploadCommand({ Bucket: u.Bucket, Key: u.Key, UploadId: u.UploadId, MultipartUpload: { Parts: parts } }));
  async function cancel(a, u, version) {
    assert.equal(await repo.settleAttempt(a.identity, u.writer, 'cancelled', version), true);
    const result = await s.sweep(m); assert.equal((await repo.findAttempt(a.identity)).state, 'cleaned');
    record('owned-orphan-sweep', { cleaned: result.cleaned, actions: result.actions });
  }
  const versions = async key => s.dist('object-storage/upload-inventory').uploadVersions(storage, m.bucket, key, AbortSignal.timeout(10000));
  let expiry;
  try {
    const a = await attempt(); const u = await start(a);
    const p2 = await part(u, 2, good.subarray(5 * 1024 ** 2));
    await part(u, 1, Buffer.alloc(5 * 1024 ** 2, 42)); // replaced retry must not survive assembly
    const p1 = await part(u, 1, good.subarray(0, 5 * 1024 ** 2));
    await complete(u, [p1, p2]); // intentionally discard the successful completion reply
    assert.equal(await repo.settleAttempt(a.identity, u.writer, 'unresolved'), true);
    const resumed = await call(a.route + '/resume', 'POST', undefined, 200, a.header); assert.equal(resumed.state, 'committed');
    assert.equal((await versions(a.row.key)).length, 1);
    const link = await call(`reports/${a.identity.reportId}/download-url`);
    const download = await fetch(link.url, { signal: AbortSignal.timeout(10000), redirect: 'error' });
    assert.equal(download.status, 200); assert.equal(sha(Buffer.from(await download.arrayBuffer())), sha(good));
    expiry = { url: link.url, at: Date.parse(link.expiresAt) };
    record('multipart-out-of-order-replacement-lost-reply', { passed: true, bytes: good.length, partBytes: [5 * 1024 ** 2, 1024 ** 2], parts: [1, 2], exactVersion: true, sha256: sha(good), revisionBound: true });
    for (const failure of ['invalid-etag', 'below-minimum', 'missing-part', 'reordered-bytes', 'over-limit', 'reordered-part-list']) {
      const b = await attempt(); const v = await start(b); let parts, version, stage;
      if (failure === 'below-minimum') parts = [await part(v, 1, good.subarray(0, 1024 ** 2)), await part(v, 2, good.subarray(0, 1024 ** 2))];
      else if (failure === 'reordered-bytes') parts = [await part(v, 1, Buffer.concat([good.subarray(5 * 1024 ** 2), good.subarray(0, 4 * 1024 ** 2)])), await part(v, 2, good.subarray(4 * 1024 ** 2, 5 * 1024 ** 2))];
      else if (failure === 'over-limit') parts = [await part(v, 1, good.subarray(0, 5 * 1024 ** 2)), await part(v, 2, good)];
      else { parts = [await part(v, 1, good.subarray(0, 5 * 1024 ** 2)), await part(v, 2, good.subarray(5 * 1024 ** 2))]; }
      if (failure === 'invalid-etag') parts[0].ETag = '"00000000000000000000000000000000"';
      if (failure === 'missing-part') parts = parts.slice(0, 1);
      if (failure === 'reordered-part-list') parts.reverse();
      try { version = (await complete(v, parts)).VersionId; stage = 'assembled'; }
      catch (e) { stage = 'moto:' + e.name; }
      if (version) {
        assert.equal(await repo.settleAttempt(b.identity, v.writer, 'unresolved'), true);
        const response = await fetch(`http://127.0.0.1:${m.ports.api}/api/v1/${b.route}/resume`, { method: 'POST', headers: { Authorization: 'Bearer ' + bearer, ...b.header }, signal: AbortSignal.timeout(30000) });
        assert.equal(response.ok, false, 'Invalid multipart bytes must never be pinned');
        stage = 'application:' + response.status;
        // Fault writer has quiesced; authoritative transition plus exact-version cleanup.
        await repo.recoverAttempt(b.identity, version); await repo.cancelAttempt(b.identity);
        assert.equal((await s.sweep(m)).cleaned, 1);
      } else await cancel(b, v);
      assert.equal((await versions(b.row.key)).length, 0);
      record('multipart-' + failure, { passed: true, rejectionStage: stage });
    }
    // Interrupted writer: unknown upload is retained; a durable receipt later permits exact abort.
    const b = await attempt(); const v = await start(b); await part(v, 1, good.subarray(0, 5 * 1024 ** 2));
    const receipts = JSON.parse(o.read(path.join(m.root, 'multipart.json')));
    s.saveMultipart(m, receipts.filter(r => r.uploadId !== v.UploadId));
    assert.equal(await repo.settleAttempt(b.identity, v.writer, 'cancelled'), true);
    assert.equal((await s.sweep(m)).preserved, 1);
    s.saveMultipart(m, receipts);
    await storage.send(new sdk.AbortMultipartUploadCommand({ Bucket: v.Bucket, Key: v.Key, UploadId: v.UploadId })); // reply loss after provider acted
    assert.equal((await s.sweep(m)).cleaned, 1);
    await assert.rejects(storage.send(new sdk.ListPartsCommand({ Bucket: v.Bucket, Key: v.Key, UploadId: v.UploadId })), e => e.name === 'NoSuchUpload');
    assert.equal((await s.dist('object-storage/upload-inventory').uploadMultipart(storage, m.bucket, 'local-storage/' + m.id + '/', AbortSignal.timeout(10000))).length, 0);
    record('multipart-interrupt-unknown-receipt-abort-reply-loss', { passed: true, remainingUploads: 0 });
    // Protocol transport faults remain distinct from the multipart assembly writer.
    for (const fault of ['chunked', 'form-data', 'size-overrun', 'disconnect']) {
      const b = await attempt(small); const before = (await versions('local-storage/' + m.id + '/')).length;
      const http = require('node:http');
      const status = await new Promise((resolve, reject) => {
        const req = http.request(`http://127.0.0.1:${m.ports.api}/api/v1/${b.route}/bytes`, { method: 'PUT', headers: { Authorization: 'Bearer ' + bearer, ...b.header, 'Content-Type': fault === 'form-data' ? 'multipart/form-data; boundary=synthetic' : 'application/pdf' } }, response => { response.resume(); response.on('end', () => resolve(response.statusCode)); });
        req.on('error', e => fault === 'disconnect' ? resolve(0) : reject(e)); req.setTimeout(12000, () => req.destroy());
        if (fault === 'disconnect') { req.write(small.subarray(0, 9)); setTimeout(() => req.destroy(), 50); }
        else { req.write(small); if (fault === 'size-overrun') req.write('extra'); req.end(); }
      });
      if (fault === 'chunked') assert.equal(status, 200);
      else { assert.equal(status >= 400 || status === 0, true); await new Promise(r => setTimeout(r, 100)); assert.equal((await versions('local-storage/' + m.id + '/')).length, before); await call(b.route + '/cancel', 'POST', undefined, 200, b.header); }
      record('http-' + fault, { passed: true, status, zeroStorageWritesOnRefusal: fault !== 'chunked' });
    }
    // Crash an actual intake writer after its private staging receipt exists.
    const crashed = await attempt(good);
    const http = require('node:http');
    const upload = http.request(`http://127.0.0.1:${m.ports.api}/api/v1/${crashed.route}/bytes`, { method: 'PUT', headers: { Authorization: 'Bearer ' + bearer, ...crashed.header, 'Content-Type': 'application/pdf' } });
    upload.on('error', () => {}); upload.write(good.subarray(0, 1024));
    const fs = require('node:fs'); const stagedRoot = path.join(m.root, 'stage');
    for (let n = 0; n < 100 && !fs.readdirSync(stagedRoot).some(n => n.startsWith('telesphoros-intake-')); n++) await new Promise(r => setTimeout(r, 20));
    assert.equal(fs.readdirSync(stagedRoot).some(n => n.startsWith('telesphoros-intake-')), true);
    const worker = o.load(m.id).processes.find(p => p.name === 'api'); assert.equal(o.live(worker), true); process.kill(worker.pid, 'SIGKILL'); upload.destroy();
    for (let n = 0; n < 100 && o.identity(worker.pid); n++) await new Promise(r => setTimeout(r, 20));
    m = await require('./runtime.cjs').restartApi(m.id);
    assert.deepEqual(fs.readdirSync(stagedRoot), []);
    const pending = await repo.findAttempt(crashed.identity); assert.equal(pending.state, 'intaking');
    // Change only this synthetic journal fixture's lease. Database time remains authoritative.
    const { Client } = s.backend('pg'); const owner = new Client({ connectionString: s.dbUrl(m, 'storage_owner') });
    try {
      await owner.connect();
      await owner.query("UPDATE report_upload_attempts SET lease_until=now()-interval '24 hours'+interval '1 minute' WHERE tenant_id=$1 AND id=$2", ['alpha', crashed.attemptId]);
      assert.equal(await repo.claimCleanup('alpha', crashed.attemptId, 86400), false);
      await owner.query("UPDATE report_upload_attempts SET lease_until=now()-interval '24 hours'-interval '1 minute' WHERE tenant_id=$1 AND id=$2", ['alpha', crashed.attemptId]);
      assert.equal((await s.sweep(m)).cleaned, 1);
    } finally { await owner.end(); }
    record('crashed-staging-startup-recovery-default-grace', { passed: true, stagingRemaining: 0, graceSeconds: 86400, providerClockChanged: false });
    // A receipt failure happens before the library can update PostgreSQL. The actual
    // API worker must still close its listener, then reopen only after a successful sweep.
    const manifest = path.join(m.root, 'manifest.json'), originalManifest = o.read(manifest);
    const activeWorker = o.load(m.id).processes.find(p => p.name === 'api');
    o.atomic(manifest, originalManifest.replace('disabled', 'enabled'));
    try {
      assert.equal(o.live(activeWorker), true); process.kill(activeWorker.pid, 'SIGUSR2');
      for (let n = 0; n < 100 && require('./runtime.cjs').listener(m, 'api'); n++) await new Promise(r => setTimeout(r, 50));
      assert.equal(require('./runtime.cjs').listener(m, 'api'), false);
    } finally { o.atomic(manifest, originalManifest); }
    assert.equal((await require('./runtime.cjs').sweepNow(m.id)).success, true);
    assert.equal(require('./runtime.cjs').listener(m, 'api'), true);
    record('sweep-failure-closes-admission-success-reopens', { passed: true, actualApiListener: true });
    // Last: a new version must never substitute the committed multipart pin.
    await storage.send(new sdk.PutObjectCommand({ Bucket: m.bucket, Key: a.row.key, Body: small, ContentType: 'application/pdf' }));
    const pinned = await call(`reports/${a.identity.reportId}/download-url`);
    const same = await fetch(pinned.url, { signal: AbortSignal.timeout(10000) }); assert.equal(sha(Buffer.from(await same.arrayBuffer())), sha(good));
    record('multipart-newer-version-preserves-pin', { passed: true });
    return expiry;
  } finally { storage.destroy(); await db.onModuleDestroy(); }
}
module.exports = { protocol, token, client, sha };
