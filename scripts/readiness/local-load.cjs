// Local synthetic rehearsal only. Reuses the real API and existing restricted-role fixture harness.
const { createRequire } = require('node:module');
const { readFileSync, writeFileSync } = require('node:fs');
const { join, isAbsolute } = require('node:path');
const { performance } = require('node:perf_hooks');
const { randomUUID } = require('node:crypto');
const root = join(__dirname, '../..');
const backend = createRequire(join(root, 'apps/backend/package.json'));
const { transformSync } = backend('@swc/core');
require.extensions['.ts'] = (module, filename) => {
  const { code } = transformSync(readFileSync(filename, 'utf8'), {
    filename, jsc: { target: 'es2022', parser: { syntax: 'typescript', decorators: true }, transform: { legacyDecorator: true, decoratorMetadata: true } },
    module: { type: 'commonjs' },
  });
  module._compile(code, filename);
};

async function main() {
  const target = new URL(process.env.TEST_DATABASE_URL);
  const output = process.argv[2];
  if (!['postgres:', 'postgresql:'].includes(target.protocol) || target.hostname !== '127.0.0.1' || target.pathname !== '/postgres' || !output || !isAbsolute(output))
    throw new Error('Requires a disposable loopback PostgreSQL cluster and an absolute evidence file.');
  if (process.env.TEST_OBJECT_STORAGE === 's3' && new URL(process.env.TEST_S3_ENDPOINT).hostname !== '127.0.0.1')
    throw new Error('Requires loopback synthetic storage; remote endpoints are refused.');
  const { createEphemeralDatabase, withAdmin } = require(join(root, 'apps/backend/test/helpers/database.ts'));
  const { createTestApp } = require(join(root, 'apps/backend/test/helpers/app.ts'));
  const { signToken } = require(join(root, 'apps/backend/test/helpers/tokens.ts'));
  const pg = await createEphemeralDatabase();
  const apps = [];
  // Declared before measuring. This is a local regression budget, not a production SLA/capacity claim.
  const report = { synthetic: true, workload: 'two API instances in one Node process, three tenants, PostgreSQL restricted application roles; rate limiter disabled',
    thresholds: { errorRate: 0, p95Ms: 2000 }, phases: [], duplicates: null, passed: false };
  try {
    for (let i = 0; i < 2; i++) apps.push(await createTestApp({ postgresUrl: pg.appUrl, databasePoolMax: 4 }));
    const origins = apps.map((app) => { const address = app.getHttpServer().address(); return `http://127.0.0.1:${address.port}`; });
    const tokens = await Promise.all(['a', 'b', 'c'].map((t) => signToken({ sub: `syn-load-${t}`, tenant: `syn-load-${t}`, roles: ['clinician'] })));
    async function call(instance, tenant, path, init = {}) {
      const response = await fetch(origins[instance] + '/api/v1' + path, { ...init, signal: AbortSignal.timeout(5000), headers: {
        'Content-Type': 'application/json', Authorization: `Bearer ${tokens[tenant]}`,
      } });
      return { status: response.status, body: await response.json() };
    }
    // Real API creation seeds membership through the existing synthetic test verifier.
    for (let tenant = 0; tenant < 3; tenant++) for (let n = 0; n < 20; n++) {
      const created = await call(n % 2, tenant, '/patients', { method: 'POST', body: JSON.stringify({ label: `SYN-${tenant}-${n}`, requestId: randomUUID() }) });
      if (created.status !== 201) throw new Error('Synthetic seed was refused.');
    }
    const requestId = randomUUID();
    const repeated = await Promise.all(Array.from({ length: 16 }, (_, i) => call(i % 2, 0, '/patients', {
      method: 'POST', body: JSON.stringify({ label: 'SYN-0-REPEAT', requestId }),
    })));
    const mismatch = await call(1, 0, '/patients', { method: 'POST', body: JSON.stringify({ label: 'SYN-0-OTHER', requestId }) });
    const rows = await withAdmin(pg.adminUrl, (c) => c.query('SELECT count(*)::int AS n FROM patients WHERE tenant_id=$1 AND creation_request_id=$2', ['syn-load-a', requestId]));
    report.duplicates = { requests: 16, successfulResponses: repeated.filter((r) => r.status === 201).length,
      distinctRecords: new Set(repeated.map((r) => r.body.id)).size, storedRows: rows.rows[0].n, changedPayloadStatus: mismatch.status };
    if (report.duplicates.successfulResponses !== 16 || report.duplicates.distinctRecords !== 1 || report.duplicates.storedRows !== 1 || mismatch.status !== 409)
      throw new Error('Concurrent replay/payload consistency failed.');

    async function phase(name, concurrency, limit, durationMs = 0) {
      let next = 0, errors = 0;
      const latencies = [];
      const cpu = process.cpuUsage();
      const started = performance.now();
      await Promise.all(Array.from({ length: concurrency }, async () => {
        while (next < limit && (!durationMs || performance.now() - started < durationMs)) {
          const n = next++;
          const at = performance.now();
          try {
            const result = await call(n % 2, n % 3, '/patients?page=1&pageSize=20');
            if (result.status !== 200 || result.body.data.length !== 20 || result.body.data.some((p) => !p.label.startsWith(`SYN-${n % 3}-`))) errors++;
          } catch { errors++; }
          latencies.push(performance.now() - at);
        }
      }));
      latencies.sort((a, b) => a - b);
      const seconds = (performance.now() - started) / 1000;
      const total = latencies.length;
      const percentile = (p) => Math.round(latencies[Math.max(0, Math.ceil(latencies.length * p) - 1)] * 100) / 100;
      const usage = process.cpuUsage(cpu);
      const metrics = { name, concurrency, requestLimit: limit, durationLimitMs: durationMs, requests: total, errors, errorRate: errors / total, seconds, requestsPerSecond: total / seconds,
        p50Ms: percentile(.5), p95Ms: percentile(.95), p99Ms: percentile(.99), maxMs: latencies.at(-1),
        processCpuMs: (usage.user + usage.system) / 1000, processRssBytes: process.memoryUsage().rss };
      report.phases.push(metrics);
      if (metrics.errorRate > report.thresholds.errorRate || metrics.p95Ms > report.thresholds.p95Ms) throw new Error('Local workload acceptance threshold exceeded.');
    }
    await phase('baseline', 4, 120);
    await phase('bounded sustained load', 8, 60000, 30000);
    await phase('spike', 24, 240);
    await phase('recovery', 4, 120);
    report.passed = true;
  } finally {
    writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
    const closed = await Promise.allSettled(apps.map((app) => app.close()));
    await pg.drop(); // Only the fresh database allocated above; no caller-named application database.
    if (closed.some((r) => r.status === 'rejected')) throw new Error('Synthetic API fixture cleanup failed.');
  }
}
if (require.main === module) main().catch(() => { process.stderr.write('Local readiness rehearsal failed; inspect its synthetic evidence and fixture logs.\n'); process.exitCode = 1; });
