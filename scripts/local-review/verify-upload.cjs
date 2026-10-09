// Live local API + S3-protocol refusal checks. Never invokes an AWS endpoint.
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { createRequire } = require('node:module');
const path = require('node:path');
const root=path.resolve(__dirname,'../..');
for (const name of Object.keys(process.env)) if (name.startsWith('AWS_')) delete process.env[name];
const req = createRequire(path.join(root, 'apps/backend/package.json'));
const { startFakeIdp, DEFAULT_USERS } = require('../../packages/fake-idp/dist/index.cjs');

(async () => {
  const idp = await startFakeIdp({ port: 0 });
  let app;
  try {
    req('reflect-metadata');
    const { NestFactory } = req('@nestjs/core');
    const { AppModule } = require('../../apps/backend/dist/app.module');
    const { configureApp } = require('../../apps/backend/dist/app.factory');
    const { loadEnv } = require('../../apps/backend/dist/config/env');
    // Credentials below are dummy emulator identifiers, never actual AWS credentials.
    process.env.AWS_ACCESS_KEY_ID = 'local-emulator'; process.env.AWS_SECRET_ACCESS_KEY = 'local-emulator';
    process.env.AWS_EC2_METADATA_DISABLED = 'true';
    const env = loadEnv({ NODE_ENV: 'test', LOG_LEVEL: 'silent', AUTH_VERIFIER: 'cognito', COGNITO_APP_CLIENT_ID: 'fake-client-id', COGNITO_ISSUER: idp.issuer, COGNITO_JWKS_URI: `${idp.issuer}/.well-known/jwks.json`, OBJECT_STORAGE_DRIVER: 's3', S3_ENDPOINT: 'http://127.0.0.1:'+(process.env.LOCAL_REVIEW_MOTO_PORT||'5555'), S3_FORCE_PATH_STYLE: 'true', REPORTS_BUCKET: 'telesphoros-local-demo' });
    app = await NestFactory.create(AppModule.register(env), { logger: false });
    configureApp(app); await app.listen(0, '127.0.0.1');
    const origin = await app.getUrl();
    const token = await idp.mintAccessToken();
    const reader = await idp.mintAccessToken({ user: DEFAULT_USERS[1] });
    const call = (p, body, auth = token, method = 'POST') => fetch(`${origin}/api/v1${p}`, { method, headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: `Bearer ${auth}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    assert.equal((await call('/patients', { label: 'SYN-DENIED' }, '')).status, 401);
    assert.equal((await call('/patients', { label: 'SYN-DENIED' }, reader)).status, 403);
    const patient = await (await call('/patients', { label: 'SYN-LIVE-CONTROL' })).json();
    const bytes = Buffer.from('{"synthetic":true}');
    const sha = createHash('sha256').update(bytes).digest('hex');
    for (const test of ['checksum', 'missing', 'size', 'type', 'success']) {
      const created = await call('/reports', { patientId: patient.id, type: 'structured', filename: 'synthetic.json', sizeBytes: bytes.length });
      assert.equal(created.status, 201); const report = await created.json();
      const targetResponse = await call(`/reports/${report.id}/upload-url`, { contentType: 'application/json', sha256: test === 'checksum' ? '0'.repeat(64) : sha });
      assert.equal(targetResponse.status, 200); const target = await targetResponse.json();
      assert.equal(new URL(target.uploadUrl).origin, 'http://127.0.0.1:'+(process.env.LOCAL_REVIEW_MOTO_PORT||'5555'));
      if (test !== 'missing') {
        const put = await fetch(target.uploadUrl, { method: 'PUT', headers: { 'Content-Type': test === 'type' ? 'text/plain' : 'application/json' }, body: test === 'size' ? Buffer.from('x') : bytes });
        assert.equal(put.status, 200);
      }
      const complete = await call(`/reports/${report.id}/complete`);
      assert.equal(complete.status, test === 'success' ? 200 : 409);
      const read = await (await call(`/reports/${report.id}`, undefined, token, 'GET')).json();
      assert.equal(read.fileUploaded, test === 'success');
      if (test === 'missing') {
        assert.equal((await fetch(target.uploadUrl, { method: 'PUT', headers: target.headers, body: bytes })).status, 200);
        assert.equal((await call(`/reports/${report.id}/complete`)).status, 200);
      }
      if (test === 'success') assert.equal(read.sha256, sha);
      console.log(`PASS ${test}`);
    }
    console.log('PASS unauthenticated 401; reader 403; missing upload recovered');
  } finally { if (app) await app.close(); await idp.stop(); }
})().catch(() => { console.error('FAIL local upload checks (no token/configuration output)'); process.exitCode = 1; });
