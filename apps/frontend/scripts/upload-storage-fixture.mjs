// Browser-test fixture only: fresh in-memory S3 on loopback, no cloud credentials or persisted files.
import { spawn } from 'node:child_process';
import net from 'node:net';
import { reportsCorsXml } from '../../../scripts/local-storage/cors.cjs';
const origin = 'http://127.0.0.1:5557';
const runId = process.env.L2_BROWSER_RUN_ID;
if (runId && !/^[a-f0-9-]{36}$/.test(runId)) throw new Error('Invalid owned browser run');
const bucket = runId ? `synthetic-storage-${runId}` : 'synthetic-product-upload';
let child;
async function main() {
  // Refuse an occupied port rather than initialize somebody else's emulator.
  await new Promise((resolve, reject) => {
    const probe = net.createServer(); probe.once('error', reject);
    probe.listen(5557, '127.0.0.1', () => probe.close(resolve));
  });
  child = spawn(process.env.MOTO_SERVER || 'moto_server', ['-H', '127.0.0.1', '-p', '5557'], {
    // Moto's global Flask CORS fallback otherwise admits origins outside the bucket rule.
    env: { PATH: process.env.PATH, AWS_EC2_METADATA_DISABLED: 'true', MOTO_DISABLE_GLOBAL_CORS: 'true' }, stdio: 'ignore',
  });
  child.once('error', () => { console.error('S3 browser fixture could not start. Install the pinned CI Moto dependency.'); process.exitCode = 1; });
  child.once('exit', code => process.exit(process.exitCode || code || 0));
  let ready = false;
  for (let attempt = 0; attempt < 30; attempt++) {
    try { ready = (await fetch(origin + '/moto-api/', { signal: AbortSignal.timeout(1000) })).ok; } catch { /* The owned emulator is not ready yet. */ }
    if (ready) break;
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  if (!ready) throw new Error('fixture timeout');
  for (const [suffix, body] of [
    ['', undefined],
    ['?versioning', '<VersioningConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Status>Enabled</Status></VersioningConfiguration>'],
    ['?cors', reportsCorsXml('http://127.0.0.1:4173')],
  ]) {
    const response = await fetch(origin + '/' + bucket + suffix, { method: 'PUT', body, signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error('fixture initialization');
  }
  console.log('Synthetic browser S3 fixture ready on loopback.');
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { if (child) child.kill('SIGTERM'); else process.exit(0); });
main().catch(() => { console.error('S3 browser fixture failed; generated responses withheld.'); if (child) child.kill('SIGTERM'); process.exitCode = 1; });
