// Local experiment only. Source snapshot: main 435e532. Never deploy this launcher.
const { spawn } = require('node:child_process');
const { createRequire } = require('node:module');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');
const poppler = process.argv.includes('--poppler');
function port(name,fallback){const value=process.env[name]||fallback;if(!/^[1-9][0-9]{3,4}$/.test(value)||Number(value)>65535)throw new Error('Invalid local port');return value;}
const ports={web:port('LOCAL_REVIEW_WEB_PORT','4173'),idp:port('LOCAL_REVIEW_IDP_PORT','4010'),api:port('LOCAL_REVIEW_API_PORT','3010'),moto:port('LOCAL_REVIEW_MOTO_PORT','5555'),pg:port('LOCAL_REVIEW_PG_PORT','54359')};
if (process.versions.unicode !== '16.0') {
  console.error('Demo requires a Node runtime with Unicode 16.0; use the verified Node 22 command in scripts/local-review/README.md.');
  process.exit(1);
}
const APP = `http://127.0.0.1:${ports.web}`;
const IDP = `http://127.0.0.1:${ports.idp}`;
// Pass only local runtime essentials; do not inherit AWS credentials or database settings.
const env = {
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  TMPDIR: process.env.TMPDIR,
  LOCAL_REVIEW_WEB_PORT:ports.web, LOCAL_REVIEW_IDP_PORT:ports.idp, LOCAL_REVIEW_API_PORT:ports.api, LOCAL_REVIEW_MOTO_PORT:ports.moto, LOCAL_REVIEW_PG_PORT:ports.pg, LOCAL_POPPLER_BINARY:process.env.LOCAL_POPPLER_BINARY,
  NODE_ENV: 'development', LOG_LEVEL: 'silent', PORT: ports.api,
  AUTH_VERIFIER: 'cognito', COGNITO_APP_CLIENT_ID: 'e2e-client',
  COGNITO_ISSUER: IDP, COGNITO_JWKS_URI: `${IDP}/.well-known/jwks.json`,
  CORS_ALLOWED_ORIGINS: APP, OBJECT_STORAGE_DRIVER: 's3',
  S3_ENDPOINT: `http://127.0.0.1:${ports.moto}`, S3_FORCE_PATH_STYLE: 'true', AWS_REGION: 'us-east-2',
  REPORTS_BUCKET: 'telesphoros-local-demo', AWS_ACCESS_KEY_ID: 'local-emulator', AWS_SECRET_ACCESS_KEY: 'local-emulator', AWS_EC2_METADATA_DISABLED: 'true',
  LAB_REPORT_PIPELINE: 'enabled',
  STORAGE_DRIVER: 'postgres', DATABASE_URL: `postgresql://demo_app@127.0.0.1:${ports.pg}/synthetic_review`,
  LEDGER_VERIFIER_DATABASE_URL: `postgresql://demo_verifier@127.0.0.1:${ports.pg}/synthetic_review`,
  LAB_REPORT_FIXTURES_DIR: path.join(root, 'knowledge/lab-report-reader/v2-handoff/fixtures/captures'),
  KNOWLEDGE_DIR: path.join(root, 'data/fixtures/knowledge/test-only-reader'), BUILD_VERSION: poppler ? 'local-poppler-review-1' : 'local-recorded-review-1',
  VITE_LOCAL_REVIEW_S3_ORIGIN: `http://127.0.0.1:${ports.moto}`, VITE_OIDC_AUTHORITY: IDP, VITE_OIDC_CLIENT_ID: 'e2e-client',
  VITE_COGNITO_DOMAIN: IDP, VITE_API_BASE_URL: `http://127.0.0.1:${ports.api}`,
};

if (process.argv.includes('--api')) {
  (async () => {
    const fromBackend = createRequire(path.join(root, 'apps/backend/package.json'));
    fromBackend('reflect-metadata');
    const { NestFactory } = fromBackend('@nestjs/core');
    const { Logger } = fromBackend('nestjs-pino');
    const { AppModule } = require('../../apps/backend/dist/app.module');
    const { configureApp } = require('../../apps/backend/dist/app.factory');
    const { loadEnv } = require('../../apps/backend/dist/config/env');
    const config = loadEnv();
    let app;
    if(poppler){
      const { Test }=fromBackend('@nestjs/testing');
      const { TextCaptureRunner }=require('../../apps/backend/dist/lab-reports/runner/text-capture-runner');
      const { LocalPopplerRunner }=require('./local-poppler-runner.cjs');
      const moduleRef=await Test.createTestingModule({imports:[AppModule.register(config)]}).overrideProvider(TextCaptureRunner).useValue(await LocalPopplerRunner.open()).compile();
      app=moduleRef.createNestApplication({logger:false});
    }else app = await NestFactory.create(AppModule.register(config), { logger: false });
    app.useLogger(app.get(Logger));
    configureApp(app, { corsOrigins: config.CORS_ALLOWED_ORIGINS });
    app.enableShutdownHooks();
    await app.listen(config.PORT, '127.0.0.1');
    console.log(`Local synthetic API ready on 127.0.0.1:${ports.api}; ${poppler ? 'actual Poppler' : 'recorded text'}`);
  })().catch(error => { console.error('Local API failed to start:', error.code || error.name); process.exit(1); });
} else {
  const children = [];
  let stopping = false;
  function stop(code = 0) {
    if (stopping) return;
    stopping = true;
    for (const child of children) child.kill('SIGTERM');
    process.exitCode = code;
  }
  function start(args, cwd = root, executable = process.execPath, stdio = 'inherit') {
    const child = spawn(executable, args, { cwd, env, stdio });
    children.push(child);
    child.on('error', () => stop(1));
    child.on('exit', code => { if (!stopping) stop(code || 1); });
  }
  (async () => {
    // Refuse an existing emulator: never reconfigure another process's bucket.
    const net = require('node:net');
    await new Promise((resolve, reject) => {
      const probe = net.createServer();
      probe.once('error', () => reject(new Error('Local emulator port is occupied.')));
      probe.listen(Number(ports.moto), '127.0.0.1', () => probe.close(resolve));
    });
    start(['-m', 'moto.server', '-H', '127.0.0.1', '-p', ports.moto], root, process.env.LOCAL_MOTO_PYTHON || 'python3', 'ignore');
    let ready = false;
    for (let attempt = 0; attempt < 50 && !stopping; attempt++) {
      try { ready = (await fetch(env.S3_ENDPOINT)).ok; } catch {}
      if (ready) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (!ready || stopping) throw new Error('Local emulator did not start.');
    const fromBackend = createRequire(path.join(root, 'apps/backend/package.json'));
    const { S3Client, CreateBucketCommand, PutBucketVersioningCommand, PutBucketCorsCommand } = fromBackend('@aws-sdk/client-s3');
    const client = new S3Client({ region: env.AWS_REGION, endpoint: env.S3_ENDPOINT, forcePathStyle: true, credentials: { accessKeyId: env.AWS_ACCESS_KEY_ID, secretAccessKey: env.AWS_SECRET_ACCESS_KEY } });
    await client.send(new CreateBucketCommand({ Bucket: env.REPORTS_BUCKET, CreateBucketConfiguration: { LocationConstraint: env.AWS_REGION } }));
    await client.send(new PutBucketVersioningCommand({ Bucket: env.REPORTS_BUCKET, VersioningConfiguration: { Status: 'Enabled' } }));
    await client.send(new PutBucketCorsCommand({ Bucket: env.REPORTS_BUCKET, CORSConfiguration: { CORSRules: [{ AllowedOrigins: [APP], AllowedMethods: ['PUT'], AllowedHeaders: ['content-type'], ExposeHeaders: ['ETag'] }] } }));
    client.destroy();
    start([path.join(root, 'packages/fake-idp/dist/cli.js'), '--port', ports.idp, '--client-id', 'e2e-client', '--redirect-uri', `${APP}/auth/callback`, '--logout-uri', `${APP}/signed-out`]);
    start([__filename, '--api', ...(poppler ? ['--poppler'] : [])]);
    start([path.join(root, 'apps/frontend/node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', ports.web, '--strictPort'], path.join(root, 'apps/frontend'));
  })().catch(() => { console.error('Local demo startup failed; no configuration values logged.'); stop(1); });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => stop());
  console.log(`Synthetic demo: ${APP}. Sign in as alice. Ctrl+C stops all four local services.`);
}
