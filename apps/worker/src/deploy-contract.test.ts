import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadConfig } from './config';
import { jsonLogger } from './log';
import { Ticker } from './scheduler';
import { shutdownDeadlineMs } from './shutdown';

/**
 * The contract between the worker and its Terraform (infrastructure/terraform/worker.tf, NOT applied): the environment block is handed to the worker's OWN
 * loader as a production configuration, and the CloudWatch filter patterns are evaluated against the lines the worker's OWN logger writes. The text guard
 * (worker.guard.test.mjs) pins the settings; this proves the two sides still agree.
 */
const tf = readFileSync(new URL('../../../infrastructure/terraform/worker.tf', import.meta.url), 'utf8');
const code = tf.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');

const PLACEHOLDERS: Record<string, string> = {
  'aws_s3_bucket.reports.bucket': 'telesphoros-staging-reports-123456789012',
  'var.region': 'us-east-2',
  'tostring(local.worker_health)': '8081',
};

function environment(): Record<string, string> {
  const start = code.indexOf('worker_environment = {');
  const end = code.indexOf('\n  }', start);
  const env: Record<string, string> = {};
  for (const m of code.slice(start, end).matchAll(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.+)$/gm)) {
    const expr = m[2]!.trim();
    if (/^".*"$/.test(expr) && !expr.includes('${')) env[m[1]!] = expr.slice(1, -1);
    else if (expr in PLACEHOLDERS) env[m[1]!] = PLACEHOLDERS[expr]!;
    else throw new Error(`worker.tf: ${m[1]} (${expr}) is not an expression this test can evaluate: teach it deliberately`);
  }
  return env;
}

const LOGIN = { DATABASE_URL: 'postgres://job_worker_login@db.example:5432/telesphoros' };

describe('worker.tf and the worker agree', () => {
  it('the task environment is accepted by the worker as a production configuration', () => {
    const env = environment();
    expect(Object.keys(env).length).toBeGreaterThanOrEqual(8);
    const c = loadConfig({ ...env, ...LOGIN }, 'ip-10-0-0-1');
    expect(c).toMatchObject({ databaseTls: 'require', healthHost: '127.0.0.1', healthPort: 8081, testJobs: false, reportsBucket: 'telesphoros-staging-reports-123456789012', awsRegion: 'us-east-2' });
    // The login arrives only as the secret, never as plain environment.
    expect(env).not.toHaveProperty('DATABASE_URL');
  });

  it('refuses a broken environment (control)', () => {
    const env = environment();
    expect(() => loadConfig({ ...env, ...LOGIN, DATABASE_SSL: undefined })).toThrow(/DATABASE_SSL=require/);
    expect(() => loadConfig({ ...env, ...LOGIN, REPORTS_BUCKET: undefined })).toThrow(/REPORTS_BUCKET/);
    expect(() => loadConfig({ ...env, ...LOGIN, WORKER_TEST_JOBS: 'yes', WORKER_TEST_EFFECT_DIR: '/tmp/x' })).toThrow(/Test jobs are refused/);
    expect(() => loadConfig({ ...env, ...LOGIN })).not.toThrow();
  });

  it('the container is given longer to stop than the worker takes to drain, and checks the port the worker listens on', () => {
    const c = loadConfig({ ...environment(), ...LOGIN }, 'host');
    const stop = Number(/stopTimeout\s*=\s*(\d+)/.exec(code)?.[1]);
    expect(stop).toBeGreaterThan(c.drainSeconds);
    expect(stop * 1000).toBeGreaterThan(shutdownDeadlineMs(c.drainSeconds)); // the process gives up (and says so) before the runtime has to kill it
    expect(code).toMatch(/worker_health\s*=\s*8081/);
    expect(code).toMatch(/127\.0\.0\.1:\$\{local\.worker_health\}\/livez/);
  });

  it('the worker bundle is where the task definition starts it', () => {
    expect(code).toContain('command                = ["worker/main.js"]');
    const docker = readFileSync(new URL('../../../infrastructure/docker/api.Dockerfile', import.meta.url), 'utf8');
    expect(docker).toContain('/output/worker/main.js');
  });
});

// A tiny evaluator for the filter grammar worker.tf uses: `{ $.a = "x" && $.b != "y" }`, `||`, parentheses, `>` on numbers.
type Json = Record<string, unknown>;
function matches(pattern: string, line: Json): boolean {
  const tokens = pattern.replace(/^\s*\{|\}\s*$/g, '').match(/\$\.[A-Za-z]+|"[^"]*"|!=|&&|\|\||=|>|\(|\)|-?\d+(?:\.\d+)?/g) ?? [];
  let i = 0;
  const value = () => {
    const t = tokens[i++]!;
    if (t.startsWith('"')) return t.slice(1, -1);
    if (t.startsWith('$.')) return line[t.slice(2)];
    return Number(t);
  };
  const comparison = (): boolean => {
    if (tokens[i] === '(') {
      i++;
      const r = or();
      i++; // ')'
      return r;
    }
    const left = value();
    const op = tokens[i++]!;
    const right = value();
    if (left === undefined) return false; // a missing field never matches (CloudWatch: the term is false)
    if (op === '=') return left === right;
    if (op === '!=') return left !== right;
    if (op === '>') return typeof left === 'number' && left > (right as number);
    throw new Error(`unknown operator ${op}`);
  };
  const and = (): boolean => {
    let r = comparison();
    while (tokens[i] === '&&') {
      i++;
      r = comparison() && r;
    }
    return r;
  };
  const or = (): boolean => {
    let r = and();
    while (tokens[i] === '||') {
      i++;
      r = and() || r;
    }
    return r;
  };
  return or();
}

function filterPattern(name: string): string {
  const at = code.indexOf(`resource "aws_cloudwatch_log_metric_filter" "${name}"`);
  const m = /pattern\s*=\s*"(.*)"\s*$/m.exec(code.slice(at))!;
  return m[1]!.replace(/\\"/g, '"');
}

function lines(emit: (log: ReturnType<typeof jsonLogger>) => void): Json[] {
  const out: Json[] = [];
  emit(jsonLogger((l) => out.push(JSON.parse(l) as Json)));
  return out;
}

describe('the alarm patterns match the lines the worker writes', () => {
  it('the evaluator itself (controls)', () => {
    expect(matches('{ $.event = "a" && $.n > 0 }', { event: 'a', n: 1 })).toBe(true);
    expect(matches('{ $.event = "a" && $.n > 0 }', { event: 'a', n: 0 })).toBe(false);
    expect(matches('{ $.event = "a" && $.n > 0 }', { event: 'a' })).toBe(false);
    expect(matches('{ ($.e = "a" && $.o != "ok") || ($.e = "b" && $.r > 0) }', { e: 'b', r: 2 })).toBe(true);
    expect(matches('{ ($.e = "a" && $.o != "ok") || ($.e = "b" && $.r > 0) }', { e: 'a', o: 'ok' })).toBe(false);
  });

  it('a job that ended dead raises the dead-job filter; success, retry and a lost lease do not', () => {
    const p = filterPattern('worker_job_dead');
    const [dead, succeeded, retry, lost] = lines((log) => {
      log('error', 'job-finished', { jobId: 'j1', jobType: 'files.verify-stored', outcome: 'dead', code: 'file-missing' });
      log('info', 'job-finished', { jobId: 'j2', jobType: 'files.verify-stored', outcome: 'succeeded' });
      log('warn', 'job-finished', { jobId: 'j3', jobType: 'files.verify-stored', outcome: 'retry', code: 'storage-error' });
      log('warn', 'job-finished', { jobId: 'j4', jobType: 'files.verify-stored', outcome: 'not-held' });
    });
    expect(matches(p, dead!)).toBe(true);
    for (const l of [succeeded!, retry!, lost!]) expect(matches(p, l)).toBe(false);
  });

  it('a failed stored-file check raises the file filter; a good one and a clean run do not', () => {
    const p = filterPattern('worker_file_check_failed');
    const [bad, good, badRun, goodRun] = lines((log) => {
      log('error', 'file-verified', { jobId: 'j1', jobType: 'files.verify-stored', outcome: 'changed', code: 'hash-mismatch' });
      log('info', 'file-verified', { jobId: 'j2', jobType: 'files.verify-stored', outcome: 'ok' });
      log('error', 'files-reverified', { jobId: 'j3', jobType: 'files.verify-stale', count: 40, running: 2 });
      log('info', 'files-reverified', { jobId: 'j4', jobType: 'files.verify-stale', count: 40, running: 0 });
    });
    expect(matches(p, bad!)).toBe(true);
    expect(matches(p, badRun!)).toBe(true);
    expect(matches(p, good!)).toBe(false);
    expect(matches(p, goodRun!)).toBe(false);
  });

  it('the queue-stats line carries a numeric age at the top level, and only it feeds the queue filters', () => {
    const [stats, other] = lines((log) => {
      log('info', 'queue-stats', { count: 3, running: 1, dead: 0, ageSeconds: 12 });
      log('info', 'job-finished', { outcome: 'succeeded' });
    });
    for (const name of ['worker_queue_age', 'worker_heartbeat']) {
      expect(matches(filterPattern(name), stats!)).toBe(true);
      expect(matches(filterPattern(name), other!)).toBe(false);
    }
    expect(typeof stats!.ageSeconds).toBe('number');
    expect(code).toContain('value     = "$.ageSeconds"');
  });

  it('the queue-stats line carries the dead count as a number, which the dead-waiting alarm reads; other lines do not feed it', () => {
    const [stats, other] = lines((log) => {
      log('info', 'queue-stats', { count: 3, running: 1, dead: 2, ageSeconds: 12 });
      log('error', 'outbox-relay-failed', { code: 'queue-unavailable' });
    });
    expect(matches(filterPattern('worker_dead_waiting'), stats!)).toBe(true);
    expect(matches(filterPattern('worker_dead_waiting'), other!)).toBe(false);
    expect(stats!.dead).toBe(2);
    expect(code).toContain('value     = "$.dead"');
  });

  it('the queue-stats line carries the outbox age as a number, which the outbox-stuck alarm reads, and other lines do not feed it', () => {
    const [stats, other] = lines((log) => {
      log('info', 'queue-stats', { count: 3, running: 1, dead: 0, ageSeconds: 12, outboxPending: 2, outboxAgeSeconds: 700 });
      log('info', 'job-finished', { outcome: 'succeeded' });
    });
    expect(matches(filterPattern('worker_outbox_age'), stats!)).toBe(true);
    expect(matches(filterPattern('worker_outbox_age'), other!)).toBe(false);
    expect(stats!.outboxAgeSeconds).toBe(700);
    expect(typeof stats!.outboxPending).toBe('number');
    expect(code).toContain('value     = "$.outboxAgeSeconds"');
  });

  // The two tickers are built here exactly as main.ts builds them (the names are pinned against main.ts below), and fail the way a database that does not answer does.
  const emitted = async (name: string, run: () => Promise<number>): Promise<Json[]> => {
    const out: Json[] = [];
    await new Ticker(name, run, 60, jsonLogger((l) => out.push(JSON.parse(l) as Json))).tick();
    return out;
  };
  const refused = async (): Promise<number> => {
    throw new Error('connect ECONNREFUSED 10.0.0.5:5432');
  };

  it('a failed relay tick raises the relay filter and only it; a failed scheduler tick raises the scheduler filter and only it', async () => {
    const relay = await emitted('outbox-relay', refused);
    const schedule = await emitted('schedule', refused);
    expect(relay).toHaveLength(1);
    expect(schedule).toHaveLength(1);
    expect(matches(filterPattern('worker_relay_failed'), relay[0]!)).toBe(true);
    expect(matches(filterPattern('worker_schedule_failed'), relay[0]!)).toBe(false);
    expect(matches(filterPattern('worker_schedule_failed'), schedule[0]!)).toBe(true);
    expect(matches(filterPattern('worker_relay_failed'), schedule[0]!)).toBe(false);
    expect(JSON.stringify([relay, schedule])).not.toMatch(/ECONNREFUSED|10\.0\.0\.5/); // the line carries a code, not the error
  });

  it('a healthy tick, with or without work, raises neither', async () => {
    const lines_ = [...(await emitted('outbox-relay', async () => 0)), ...(await emitted('outbox-relay', async () => 3)), ...(await emitted('schedule', async () => 2))];
    expect(lines_.length).toBeGreaterThan(0); // the ones with work log "...-ran"; the silent one logs nothing
    for (const l of lines_) for (const name of ['worker_relay_failed', 'worker_schedule_failed']) expect(matches(filterPattern(name), l), `${String(l.event)} / ${name}`).toBe(false);
  });

  it('main.ts names the tickers as the test does', () => {
    const main = readFileSync(new URL('./main.ts', import.meta.url), 'utf8');
    expect(main).toContain("new Ticker('outbox-relay'");
    expect(main).toContain("new Ticker('schedule'");
  });

  it('the failure alarms need a failure in each of three consecutive minutes, and silence is healthy', () => {
    for (const [alarm, metric] of [['worker_relay_failing', 'OutboxRelayFailures'], ['worker_schedule_failing', 'ScheduleFailures']] as const) {
      const at = code.indexOf(`resource "aws_cloudwatch_metric_alarm" "${alarm}"`);
      const block = code.slice(at, code.indexOf('\n}', at));
      expect(block).toContain(`metric_name         = "${metric}"`);
      expect(block).toMatch(/period\s+= 60\b/);
      expect(block).toMatch(/evaluation_periods\s+= 3\b/);
      expect(block).toMatch(/datapoints_to_alarm\s+= 3\b/);
      expect(block).toMatch(/treat_missing_data\s+= "notBreaching"/);
    }
  });
});
