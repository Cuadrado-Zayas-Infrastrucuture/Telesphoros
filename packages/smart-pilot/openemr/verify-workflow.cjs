// Opt-in, real local EHR workflow. Never silently skip missing services.
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '../../..');
try {
  if (process.env.NODE_ENV === 'production') throw new Error();
  for (const key of ['TEST_DATABASE_URL', 'TEST_S3_ENDPOINT']) {
    const url = new URL(process.env[key]);
    if (url.hostname !== '127.0.0.1' || (key === 'TEST_S3_ENDPOINT' && (url.protocol !== 'http:' || url.username || url.password))) throw new Error();
  }
  for (const name of ['docker.env', 'seed.json', 'registration.json']) {
    const file = path.join(__dirname, '.runtime', name);
    if (!fs.statSync(file).isFile() || (fs.statSync(file).mode & 0o077)) throw new Error();
  }
} catch {
  process.stderr.write('Workflow preflight failed: require non-production, loopback TEST_DATABASE_URL / TEST_S3_ENDPOINT and private configured synthetic OpenEMR runtime files.\n');
  process.exit(1);
}
const reportPath = path.join(__dirname, '.runtime/workflow-verification.json');
const report = { startedAt: new Date().toISOString(), status: 'RUNNING',
  head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  dirtyWorktree: Boolean(execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim()),
  synthetic: true, realOpenEmr: true, postgres: true, s3Emulator: true,
  backendIdentity: 'fake-idp', captureRunner: 'recorded-D01',
};
const save = () => fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
save();
// Do not let an inherited AWS profile override the emulator-only credentials.
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('AWS_')));
for (const args of [
  ['--filter', '@telesphoros/smart-pilot', 'build'],
  ['--filter', '@telesphoros/backend', 'exec', 'jest', '--runInBand', '--testRegex', 'test/workflow/openemr.workflow.ts$'],
]) {
  const result = spawnSync('pnpm', args, {
    cwd: root, stdio: 'inherit',
    env: { ...env, NODE_ENV: 'test', TEST_STORAGE: 'postgres', TEST_OBJECT_STORAGE: 's3',
      AWS_ACCESS_KEY_ID: 'test', AWS_SECRET_ACCESS_KEY: 'test', AWS_SESSION_TOKEN: '', AWS_EC2_METADATA_DISABLED: 'true' },
  });
  if (result.status !== 0) { report.status = 'FAIL'; report.finishedAt = new Date().toISOString(); save(); process.exit(1); }
}
report.status = 'PASS'; report.finishedAt = new Date().toISOString(); save();
process.stdout.write('PASS: real synthetic OpenEMR workflow; aggregate evidence in openemr/.runtime/workflow-verification.json.\n');
