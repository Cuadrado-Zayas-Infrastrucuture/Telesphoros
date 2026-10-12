// Requires Docker. A real pinned PostgreSQL image, no existing database or AWS.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { execFileSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { postgresReady } = require('./postgres-readiness.cjs');
const image = 'postgres:16-bookworm@sha256:0ea6700a3b4f0ae6ce746519073558aed4d88a79d8d07622a9a644946c7319c4';
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 120000 });
async function until(probe) {
  for (let i = 0; i < 60; i++) {
    try { if (probe()) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw new Error('PostgreSQL startup test timed out');
}
test('rejects the temporary socket server and accepts the final TCP server', async () => {
  const name = `telesphoros-startup-test-${randomUUID().slice(0, 8)}`;
  // Hold initialization deterministically instead of relying on machine speed.
  // Create the script inside the container to avoid host bind-mount permissions.
  const entry = `cat > /docker-entrypoint-initdb.d/barrier.sh <<'SCRIPT'
touch /tmp/init-waiting
while [ ! -e /tmp/init-release ]; do sleep 0.1; done
SCRIPT
chmod 644 /docker-entrypoint-initdb.d/barrier.sh
exec /usr/local/bin/docker-entrypoint.sh postgres`;
  try {
    docker('run', '-d', '--name', name, '--network', 'none',
      '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', // isolated test only; production rehearsal remains SCRAM
      '--entrypoint', 'sh', image, '-c', entry);
    await until(() => { docker('exec', name, 'test', '-e', '/tmp/init-waiting'); return true; });
    // Positive control proves the old probe admits the initialization server.
    assert.match(docker('exec', name, 'pg_isready', '-U', 'postgres'), /accepting connections/);
    let admitted = false;
    try { admitted = postgresReady(docker, name); } catch {}
    assert.equal(admitted, false, 'must reject the temporary initialization server');
    docker('exec', name, 'touch', '/tmp/init-release');
    await until(() => postgresReady(docker, name));
    assert.equal(docker('exec', name, 'psql', '-U', 'postgres', '-Atc', 'SELECT 1').trim(), '1');
  } finally {
    // Blast radius: this run's unique disconnected container, disposable volume
    // only. No existing resources are touched; rerun recreates them.
    docker('rm', '-f', '-v', name);
  }
});
