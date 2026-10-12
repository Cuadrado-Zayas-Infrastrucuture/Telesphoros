const { createRequire } = require('node:module');
const path = require('node:path');
const fs = require('node:fs');
const o = require('./ownership.cjs');
const backend = createRequire(path.join(o.root, 'apps/backend/package.json'));
const dist = name => require(path.join(o.root, 'apps/backend/dist', name));
const dbUrl = (m, role = m.role, database = m.database) => `postgresql://${role}@127.0.0.1:${m.ports.postgres}/${database}`;
const endpoint = m => `http://127.0.0.1:${m.ports.moto}`;
function saveMultipart(m, receipts) {
  o.load(m.id);
  if (!Array.isArray(receipts) || receipts.length > 10000 || receipts.some(r => typeof r.key !== 'string' || !r.key.startsWith('local-storage/' + m.id + '/') || typeof r.uploadId !== 'string' || !r.uploadId)) throw new Error('Multipart receipt refused');
  const text = JSON.stringify(receipts); o.atomic(path.join(o.base, 'control', m.id + '-multipart.json'), text); o.atomic(path.join(m.root, 'multipart.json'), text);
}
async function sweep(m) {
  o.load(m.id);
  for (const name of ['postgres', 'moto']) if (!require('./runtime.cjs').listener(m, name)) throw new Error('Owned listener unavailable');
  const text = o.read(path.join(m.root, 'multipart.json'));
  if (text !== o.read(path.join(o.base, 'control', m.id + '-multipart.json'))) throw new Error('Multipart receipt mismatch');
  const { Database } = dist('db/database'); const { PostgresReportsRepository } = dist('storage/postgres/reports.repository');
  const { LocalUploadCleanup } = dist('reports/intake/cleanup');
  const { readEvidenceInventory } = dist('db/evidence-inventory'); const { EvidenceBudget } = dist('db/evidence-storage');
  const db = new Database({ url: dbUrl(m), ssl: 'disable', max: 2 });
  const cleanup = new LocalUploadCleanup(new PostgresReportsRepository(db), {
    runId: m.id, tenantId: 'alpha', bucket: m.bucket, endpoint: endpoint(m), databaseUrl: dbUrl(m), databaseName: m.database,
    owned: true, clinicalProcessing: 'disabled', graceSeconds: 86400,
    multipartReceipts: JSON.parse(o.read(path.join(m.root, 'multipart.json'))),
    evidenceInventory: async () => {
      // Existing catalogue reader covers every tenant and soft-deleted report/text reference.
      // Administrative read capability stays in this owned operations process, never the API.
      const inventory = await readEvidenceInventory(dbUrl(m, 'storage_owner'), new EvidenceBudget({ deadlineMs: 25000, requestMs: 5000 }));
      return { complete: true, protectedKeys: inventory.references.map(r => r.key) };
    },
  });
  try { await reconcileStaging(m); const result = await cleanup.run(); if (result.unknownVersions) throw new Error('Unknown versions retained; reconciliation stalled'); return result; } catch (error) { await new PostgresReportsRepository(db).recordReconciliation('alpha', m.id, false).catch(() => {}); throw error; } finally { cleanup.close(); await db.onModuleDestroy(); }
}
async function reconcileStaging(m) {
  const parent = path.join(m.root, 'stage'); o.privateDir(parent);
  for (const name of fs.readdirSync(parent)) {
    if (!name.startsWith('telesphoros-intake-')) throw new Error('Unexpected staging entry retained');
    const root = path.join(parent, name); o.privateDir(root);
    const receipt = JSON.parse(o.read(path.join(root, 'receipt.json'), 1024));
    if (receipt.root !== root || receipt.runId !== m.id) throw new Error('Staging ownership mismatch');
    // A live process is conservatively retained, including a reused PID. A failed
    // sweep then blocks admission through the existing durable stalled flag.
    if (o.identity(receipt.pid)) throw new Error('Live staging writer retained');
    await dist('reports/intake/staging-receipt').reconcileStaging(receipt);
  }
}
async function clocks(m) {
  const { Client } = backend('pg'); const client = new Client({ connectionString: dbUrl(m), connectionTimeoutMillis: 2000, query_timeout: 2000 });
  const hostBefore = Date.now();
  try {
    await client.connect();
    const database = Number((await client.query('SELECT extract(epoch from clock_timestamp())*1000 AS ms')).rows[0].ms);
    const response = await fetch(endpoint(m) + '/moto-api/', { signal: AbortSignal.timeout(2000), redirect: 'error', headers: { Connection: 'close' } });
    const result = require('./scheduler.cjs').clockCheck({ hostBefore, hostAfter: Date.now(), database, emulator: Date.parse(response.headers.get('date')) });
    o.atomic(path.join(m.root, 'clock.json'), JSON.stringify(result)); return result;
  } finally { await client.end(); }
}
async function api(m) {
  backend('reflect-metadata');
  const { NestFactory } = backend('@nestjs/core'); const { Logger } = backend('nestjs-pino');
  const { AppModule } = dist('app.module'); const { configureApp } = dist('app.factory'); const { loadEnv } = dist('config/env');
  const idp = `http://127.0.0.1:${m.ports.idp}`, appOrigin = `http://127.0.0.1:${m.ports.web}`;
  const env = loadEnv({ NODE_ENV: 'development', PORT: String(m.ports.api), LOG_LEVEL: 'silent', AUTH_VERIFIER: 'cognito', COGNITO_APP_CLIENT_ID: 'e2e-client', COGNITO_ISSUER: idp, COGNITO_JWKS_URI: idp + '/.well-known/jwks.json', CORS_ALLOWED_ORIGINS: appOrigin, STORAGE_DRIVER: 'postgres', DATABASE_URL: dbUrl(m), DATABASE_SSL: 'disable', OBJECT_STORAGE_DRIVER: 's3', S3_ENDPOINT: endpoint(m), S3_FORCE_PATH_STYLE: 'true', AWS_REGION: 'us-east-2', REPORTS_BUCKET: m.bucket, LOCAL_STORAGE_RUN_ID: m.id, LAB_REPORT_PIPELINE: 'disabled', RATE_LIMIT_ENABLED: 'false', DOWNLOAD_URL_TTL_SECONDS: '60' });
  let app, listening = false, stopping = false;
  const { scheduler, guardAdmission } = require('./scheduler.cjs');
  const guarded = guardAdmission(() => sweep(o.load(m.id)), async () => {
    if (app && !listening && !stopping) {
      const server = app.getHttpServer();
      await new Promise((resolve, reject) => { const fail = error => reject(error); server.once('error', fail); server.listen(m.ports.api, '127.0.0.1', () => { server.off('error', fail); resolve(); }); }); listening = true;
    }
  }, async () => {
    if (app && listening) { const server = app.getHttpServer(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); listening = false; }
  });
  let sequence = 0; const history = []; const schedule = scheduler(guarded, {
    record: result => { const dir = o.privateDir(m.root); if (dir.dev !== m.directory.dev || dir.ino !== m.directory.ino) throw new Error('Run directory replaced'); history.push({ sequence: ++sequence, at: new Date().toISOString(), ...result }); if (history.length > 100) history.shift(); o.atomic(path.join(m.root, 'sweeps.json'), JSON.stringify(history)); },
  });
  await clocks(m); await schedule.start();
  app = await NestFactory.create(AppModule.register(env), { bufferLogs: true, logger: false });
  app.useLogger(app.get(Logger)); configureApp(app, { corsOrigins: env.CORS_ALLOWED_ORIGINS, trustProxyHops: 0 });
  await app.listen(m.ports.api, '127.0.0.1'); listening = true;
  const stop = async () => { stopping = true; await schedule.stop(); app.getHttpServer().closeAllConnections(); await app.close(); };
  stop.reconcile = () => schedule.run(); // Operations/test handle only; no HTTP trigger or interval override.
  return stop;
}
module.exports = { saveMultipart, reconcileStaging, backend, dist, dbUrl, endpoint, sweep, clocks, api };
