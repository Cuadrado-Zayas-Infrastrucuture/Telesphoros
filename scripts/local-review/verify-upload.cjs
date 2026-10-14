// Live local API + S3-protocol refusal checks. Never invokes an AWS endpoint.
const assert = require('node:assert/strict');
const { createHash, randomUUID } = require('node:crypto');
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
    // Upload through the validated intake: declare an attempt, then send the bytes through the API (nothing goes to storage directly any more).
    const intake = async (reportId, bytes, contentType, who, declared = bytes, header = contentType) => {
      const state = await (await call(`/reports/${reportId}/upload-state`, undefined, who, 'GET')).json();
      const declaration = await call(`/reports/${reportId}/upload-attempts`, { requestId: randomUUID(), revision: state.revision, contentType, sha256: createHash('sha256').update(declared).digest('hex') }, who);
      if (declaration.status !== 201) return { declaration, put: undefined, attempt: undefined };
      const attempt = await declaration.json();
      const put = async (body = bytes) => fetch(`${origin}/api/v1/reports/${reportId}/upload-attempts/${attempt.attemptId}/bytes`, { method: 'PUT', headers: { Authorization: `Bearer ${who}`, 'Content-Type': header, 'X-Upload-Revision': attempt.revision }, body });
      return { declaration, attempt, put };
    };
    assert.equal((await call('/patients', { label: 'SYN-DENIED' }, '')).status, 401);
    assert.equal((await call('/patients', { label: 'SYN-DENIED' }, reader)).status, 403);
    const patient = await (await call('/patients', { label: 'SYN-LIVE-CONTROL' })).json();
    const bytes = Buffer.from('{"synthetic":true}');
    const sha = createHash('sha256').update(bytes).digest('hex');
    for (const test of ['checksum', 'missing', 'size', 'type', 'success']) {
      const created = await call('/reports', { patientId: patient.id, type: 'structured', filename: 'synthetic.json', sizeBytes: bytes.length });
      assert.equal(created.status, 201); const report = await created.json();
      // checksum: the declared hash is not the bytes' hash; size: other bytes than declared; type: the wrong content type on the transfer; missing: declared, nothing sent yet.
      const up = await intake(report.id, bytes, 'application/json', token, test === 'checksum' ? Buffer.from('{"other":true}') : bytes, test === 'type' ? 'text/plain' : 'application/json');
      assert.equal(up.declaration.status, 201);
      if (test !== 'missing') {
        const put = await up.put(test === 'size' ? Buffer.from('x') : bytes);
        assert.equal(put.status, test === 'success' ? 200 : 400);
      }
      const read = await (await call(`/reports/${report.id}`, undefined, token, 'GET')).json();
      assert.equal(read.fileUploaded, test === 'success');
      if (test === 'missing') {
        assert.equal((await up.put()).status, 200);
        assert.equal((await (await call(`/reports/${report.id}`, undefined, token, 'GET')).json()).fileUploaded, true);
      }
      if (test === 'success') assert.equal(read.sha256, sha);
      console.log(`PASS ${test}`);
    }
    console.log('PASS unauthenticated 401; reader 403; missing upload recovered');
  } finally { if (app) await app.close(); await idp.stop(); }
})().catch(() => { console.error('FAIL local upload checks (no token/configuration output)'); process.exitCode = 1; });
