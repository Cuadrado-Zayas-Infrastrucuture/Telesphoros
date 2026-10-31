import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { type Facts, run, type Sources } from './handler';

const DIGEST = `sha256:${'d5'.repeat(32)}`;
const FACTS: Facts = {
  appliedCommit: 'a'.repeat(40),
  image: { digest: DIGEST, commit: 'b'.repeat(40) },
  taskDefinitions: { api: 4, worker: 3 },
  alarms: 31,
  cloudfrontCachePaths: ['/assets/*'],
  acceptedExceptions: [{ id: 'break-glass-x', reason: 'SCP denies GitHub OIDC', reviewBy: '2026-11-30' }],
};
const NOW = new Date('2026-11-05T12:00:00Z');

/** Sources that agree with FACTS and find nothing waiting; a test overrides one. */
const sources = (over: Partial<Sources> = {}) => {
  const published: { subject: string; message: string }[] = [];
  const s: Sources = {
    facts: async () => structuredClone(FACTS),
    service: async (name) => ({ revision: name === 'api' ? 4 : 3, digest: DIGEST }),
    alarms: async () => 31,
    cloudfrontPaths: async () => ['/assets/*'],
    ready: async () => 200,
    terraformFilesSince: async () => ({ files: [], truncated: false }),
    applicationChangeSince: async () => ({ since: undefined }),
    publish: async (subject, message) => void published.push({ subject, message }),
    ...over,
  };
  return { s, published };
};
const logs = () => {
  const lines: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((...a) => void lines.push(a.join(' ')));
  vi.spyOn(console, 'error').mockImplementation((...a) => void lines.push(a.join(' ')));
  return lines;
};

describe('staging freshness check', () => {
  it('everything agrees: a complete run, no email, and the line the missed-run alarm counts', async () => {
    const lines = logs();
    const { s, published } = sources();
    const r = await run(s, NOW);
    expect(r).toMatchObject({ complete: true, findings: [], problems: [] });
    expect(published).toEqual([]);
    expect(lines).toContain('staging-freshness-ran outcome=complete findings=0 problems=0');
  });

  it.each([
    ['api.revision', { service: async (n: 'api' | 'worker') => ({ revision: n === 'api' ? 5 : 3, digest: DIGEST }) }],
    ['worker.revision', { service: async (n: 'api' | 'worker') => ({ revision: n === 'api' ? 4 : 4, digest: DIGEST }) }],
    ['api.digest', { service: async (n: 'api' | 'worker') => ({ revision: n === 'api' ? 4 : 3, digest: n === 'api' ? `sha256:${'0'.repeat(64)}` : DIGEST }) }],
    ['worker.digest', { service: async (n: 'api' | 'worker') => ({ revision: n === 'api' ? 4 : 3, digest: n === 'worker' ? `sha256:${'0'.repeat(64)}` : DIGEST }) }],
    ['alarms', { alarms: async () => 33 }],
    ['cloudfrontCachePaths', { cloudfrontPaths: async () => [] }],
    ['ready', { ready: async () => 503 }],
  ])('%s moving is exactly one finding, and an email', async (field, over) => {
    logs();
    const { s, published } = sources(over as Partial<Sources>);
    const r = await run(s, NOW);
    expect(r.findings.map((f) => f.field)).toEqual([field]);
    expect(r.complete).toBe(true);
    expect(published).toHaveLength(1);
    expect(published[0]!.subject).toBe('Staging freshness: 1 finding');
    expect(published[0]!.message).toContain(field);
  });

  it('names Terraform merged after the applied commit, by file, capped at ten', async () => {
    logs();
    const files = Array.from({ length: 12 }, (_, i) => `infrastructure/terraform/f${i}.tf`);
    const { s, published } = sources({ terraformFilesSince: async () => ({ files, truncated: false }) });
    const r = await run(s, NOW);
    expect(r.findings.map((f) => f.field)).toEqual(['terraform-unapplied']);
    expect(published[0]!.message).toContain('12 file(s)');
    expect(published[0]!.message).toContain('f9.tf');
    expect(published[0]!.message).not.toContain('f10.tf');
  });

  it('an image behind main by an application change is a finding only after seven days', async () => {
    logs();
    for (const [since, finding] of [['2026-10-29T12:00:00Z', true], ['2026-10-29T12:00:01Z', false], [undefined, false]] as const) {
      const { s } = sources({ applicationChangeSince: async () => ({ since }) });
      const r = await run(s, NOW);
      expect(r.findings.some((f) => f.field === 'image-behind-main'), String(since)).toBe(finding);
    }
  });

  it('an accepted exception is reported only once its review date has passed', async () => {
    logs();
    const before = await run(sources().s, new Date('2026-11-30T23:00:00Z'));
    expect(before.findings).toEqual([]);
    const { s, published } = sources();
    const after = await run(s, new Date('2026-12-01T00:00:01Z'));
    expect(after.findings.map((f) => f.field)).toEqual(['exception:break-glass-x']);
    expect(published[0]!.message).toContain('review date 2026-11-30 has passed');
  });

  it('a read that fails makes the run incomplete, still checks the rest, and says which read failed (never why in detail)', async () => {
    const lines = logs();
    const denied = Object.assign(new Error('User: arn:aws:sts::111122223333:assumed-role/SENTINEL is not authorized'), { name: 'AccessDeniedException' });
    const { s, published } = sources({ alarms: async () => { throw denied; }, ready: async () => 503 });
    const r = await run(s, NOW);
    expect(r.complete).toBe(false);
    expect(r.problems).toEqual(['alarms: AccessDeniedException']);
    expect(r.findings.map((f) => f.field)).toEqual(['ready']);
    expect(published).toHaveLength(1);
    expect(published[0]!.subject).toBe('Staging freshness: 1 finding, check incomplete');
    expect(published[0]!.message).toContain('could not read alarms (AccessDeniedException)');
    expect(lines).toContain('staging-freshness-ran outcome=incomplete findings=1 problems=1');
    for (const text of [published[0]!.message, ...lines]) expect(text).not.toContain('SENTINEL');
  });

  it('the facts file unreadable: incomplete, emailed, and nothing else is guessed', async () => {
    const lines = logs();
    const { s, published } = sources({ facts: async () => { throw Object.assign(new Error('x'), { name: 'GithubError' }); } });
    const r = await run(s, NOW);
    expect(r).toMatchObject({ complete: false, findings: [], problems: ['facts: GithubError'] });
    expect(published[0]!.subject).toBe('Staging freshness: check incomplete');
    expect(lines).toContain('staging-freshness-ran outcome=incomplete findings=0 problems=1');
  });

  it('a truncated GitHub answer is incomplete, never clean', async () => {
    logs();
    const { s } = sources({ terraformFilesSince: async () => ({ files: [], truncated: true }) });
    const r = await run(s, NOW);
    expect(r.complete).toBe(false);
    expect(r.problems).toEqual(['terraform-since-applied: truncated']);
  });

  it('an email that cannot be sent fails the invocation (the Errors alarm), and the run is not logged complete', async () => {
    const lines = logs();
    const { s } = sources({ alarms: async () => 33, publish: async () => { throw new Error('KMSAccessDenied'); } });
    await expect(run(s, NOW)).rejects.toThrow('KMSAccessDenied');
    expect(lines.some((l) => l.includes('outcome=complete'))).toBe(false);
    expect(lines).toContain('staging-freshness-ran outcome=incomplete findings=1 problems=1');
  });

  it('every digest in the email is shortened, and control characters never get through', async () => {
    logs();
    const { s, published } = sources({ service: async (n) => ({ revision: n === 'api' ? 4 : 3, digest: `sha256:${'0'.repeat(63)}1\u0007\n` }) });
    await run(s, NOW);
    expect(published[0]!.message).toContain('live:     sha256:000000000000\n');
    expect(published[0]!.message).not.toContain('sha256:0000000000000');
    expect(published[0]!.message).not.toContain('\u0007');
  });

  // The completion line is what the missed-run alarm counts (freshness.tf, freshness_run_complete). Lambda writes it behind a timestamp, a request
  // id and a level, so CloudWatch sees plain text and the filter is a term match: it must match the complete line and not the incomplete one.
  it('the complete line matches the filter in freshness.tf, and the incomplete line does not', async () => {
    const tf = readFileSync(new URL('../../../terraform/freshness.tf', import.meta.url), 'utf8');
    const pattern = /pattern\s*=\s*"((?:\\"|[^"])*)"\s*\n/.exec(tf.slice(tf.indexOf('freshness_run_complete')))?.[1];
    expect(pattern, 'the metric filter pattern').toBeDefined();
    const terms = [...pattern!.replace(/\\"/g, '"').matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
    expect(terms.length).toBeGreaterThanOrEqual(2);
    const matches = (line: string) => terms.every((t) => line.includes(t));
    const lines = logs();
    await run(sources().s, NOW);
    await run(sources({ alarms: async () => { throw new Error('x'); } }).s, NOW);
    const complete = lines.find((l) => l.includes('outcome=complete'))!;
    const incomplete = lines.find((l) => l.includes('outcome=incomplete'))!;
    expect(matches(`2026-11-05T12:00:00.000Z abc INFO ${complete}`)).toBe(true);
    expect(matches(`2026-11-05T12:00:00.000Z abc INFO ${incomplete}`)).toBe(false);
  });
});
