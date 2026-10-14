import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { assertPerson, defineJob, enqueueJob, fatal, isSystemActor, JobError, JobQueue, JobRegistry, retryable, retryDelaySeconds, systemActor, assertFlatPayload } from './index';

const echo = defineJob({ type: 'test.echo', payload: z.strictObject({ reportId: z.string(), n: z.number().int() }), maxAttempts: 3, leaseSeconds: 30, timeoutSeconds: 10, testOnly: true });

describe('system actors', () => {
  it('names an actor after its job type, and tells it from a person', () => {
    expect(systemActor('uploads.sweep')).toBe('system:uploads.sweep');
    expect(isSystemActor('system:uploads.sweep')).toBe(true);
    for (const person of ['11111111-1111-4111-8111-111111111111', 'user-a', 'systemic', 'a:system:b']) expect(isSystemActor(person)).toBe(false);
  });
  it('refuses a system actor where a person is required, and a malformed job type', () => {
    expect(() => assertPerson('system:uploads.sweep')).toThrow('cannot stand in for a person');
    expect(() => assertPerson('user-a')).not.toThrow();
    for (const bad of ['', 'Upper', 'a', 'has space', 'x'.repeat(65), '1abc']) expect(() => systemActor(bad)).toThrow();
  });
});

describe('error codes', () => {
  it('accepts short codes and refuses anything that could carry a message or a value', () => {
    expect(retryable('upstream-timeout')).toMatchObject({ code: 'upstream-timeout', retryable: true });
    expect(fatal('bad-input')).toMatchObject({ code: 'bad-input', retryable: false });
    for (const bad of ['', 'A', 'x', 'has space', 'report 123 failed', 'a'.repeat(49), '1abc', 'dotted.code']) expect(() => new JobError(bad, true)).toThrow();
  });
});

describe('retry delay', () => {
  it('grows by five times per attempt, is capped at an hour, and stays within 20% either way', () => {
    expect(retryDelaySeconds(1, 0.5)).toBe(60);
    expect(retryDelaySeconds(2, 0.5)).toBe(300);
    expect(retryDelaySeconds(3, 0.5)).toBe(1500);
    expect(retryDelaySeconds(4, 0.5)).toBe(3600);
    expect(retryDelaySeconds(9, 0.5)).toBe(3600);
    expect(retryDelaySeconds(2, 0)).toBeCloseTo(240);
    expect(retryDelaySeconds(2, 1)).toBeCloseTo(360);
    for (const bad of [0, -1, 1.5]) expect(() => retryDelaySeconds(bad)).toThrow();
  });
});

describe('job definitions and the registry', () => {
  it('validates limits when a job is defined', () => {
    const base = { type: 'test.x', payload: z.object({}), maxAttempts: 3, leaseSeconds: 30, timeoutSeconds: 10 };
    expect(() => defineJob(base)).not.toThrow();
    for (const bad of [{ maxAttempts: 0 }, { maxAttempts: 21 }, { leaseSeconds: 4 }, { leaseSeconds: 3601 }, { timeoutSeconds: 0 }, { type: 'Bad Type' }]) expect(() => defineJob({ ...base, ...bad })).toThrow();
  });
  it('refuses a duplicate type and keeps test-only types out of a production list', () => {
    const registry = new JobRegistry([echo, defineJob({ type: 'uploads.sweep', payload: z.object({}), maxAttempts: 5, leaseSeconds: 60, timeoutSeconds: 60 })]);
    expect(() => registry.add(echo)).toThrow('registered twice');
    expect(registry.types()).toEqual(['uploads.sweep']);
    expect(registry.types({ includeTestOnly: true })).toEqual(['test.echo', 'uploads.sweep']);
    expect(registry.get('nope')).toBeUndefined();
  });
});

describe('the flat payload rule', () => {
  it('accepts ids, integers and booleans under short lower-camel keys', () => {
    expect(() => assertFlatPayload({ reportId: '11111111-1111-4111-8111-111111111111', n: 3, dryRun: false })).not.toThrow();
  });
  it('refuses nesting, free text, long strings, null, floats, bad keys and big payloads', () => {
    for (const bad of [{ a: { b: 1 } }, { a: [1] }, { a: 'has space' }, { a: 'x'.repeat(65) }, { a: null }, { a: 1.5 }, { Bad: 'x' }, { 'a-b': 'x' }, { a: 'name.pdf' }, [], null, 'x',
      Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`k${i}`, 'x'.repeat(40)]))]) {
      expect(() => assertFlatPayload(bad)).toThrow();
    }
  });
});

describe('the queue calls the database functions, and only those', () => {
  const db = () => ({ query: vi.fn() });
  it('claims with the limits it was given and maps the rows', async () => {
    const d = db(); d.query.mockResolvedValue({ rows: [{ id: 'j1', tenant_id: 't1', type: 'test.echo', payload: { n: 1 }, attempt: 2, max_attempts: 5, lease_until: new Date(0), requested_by: 'system:scheduler' }] });
    const claimed = await new JobQueue(d).claim('w1', { types: ['test.echo'], batch: 3, tenantCap: 2, leaseSeconds: 60 });
    expect(d.query).toHaveBeenCalledWith('SELECT * FROM job_claim($1, $2::text[], $3, $4, $5)', ['w1', ['test.echo'], 3, 2, 60]);
    expect(claimed).toEqual([{ id: 'j1', tenantId: 't1', type: 'test.echo', payload: { n: 1 }, attempt: 2, maxAttempts: 5, leaseUntil: new Date(0), requestedBy: 'system:scheduler' }]);
  });
  it('reports lost leases and unowned jobs as false or undefined', async () => {
    const d = db(); const q = new JobQueue(d);
    d.query.mockResolvedValueOnce({ rows: [{ ok: false }] });
    expect(await q.heartbeat('j', 'w', 30)).toBe(false);
    d.query.mockResolvedValueOnce({ rows: [{ ok: false }] });
    expect(await q.succeed('j', 'w')).toBe(false);
    d.query.mockResolvedValueOnce({ rows: [{ state: null }] });
    expect(await q.fail('j', 'w', 'x-code', true)).toBeUndefined();
    d.query.mockResolvedValueOnce({ rows: [{ state: 'dead' }] });
    expect(await q.fail('j', 'w', 'x-code', false)).toBe('dead');
    d.query.mockResolvedValueOnce({ rows: [{ ok: true }] });
    expect(await q.release('j', 'w')).toBe(true);
  });
  it('maps stats without any row or organization', async () => {
    const d = db(); d.query.mockResolvedValue({ rows: [{ type: 'test.echo', state: 'queued', n: '3', oldest_ready_seconds: 12.5 }, { type: 'test.echo', state: 'dead', n: '1', oldest_ready_seconds: null }] });
    expect(await new JobQueue(d).stats()).toEqual([{ type: 'test.echo', state: 'queued', count: 3, oldestReadySeconds: 12.5 }, { type: 'test.echo', state: 'dead', count: 1, oldestReadySeconds: null }]);
  });
});

describe('enqueueJob', () => {
  it('parses the payload with the definition, then calls job_enqueue with the type, the payload, the key and the limits', async () => {
    const d = { query: vi.fn().mockResolvedValue({ rows: [{ job_id: 'j1', created: true }] }) };
    const when = new Date('2026-10-14T00:00:00Z');
    expect(await enqueueJob(d, echo, { reportId: 'abc-123', n: 2 }, { idempotencyKey: 'report:abc-123', runAfter: when })).toEqual({ jobId: 'j1', created: true });
    expect(d.query).toHaveBeenCalledWith('SELECT job_id, created FROM job_enqueue($1, $2::jsonb, $3, $4, $5)', ['test.echo', '{"reportId":"abc-123","n":2}', 'report:abc-123', when, 3]);
  });
  it('refuses a payload the definition or the flat rule refuses, before touching the database', async () => {
    const d = { query: vi.fn() };
    await expect(enqueueJob(d, echo, { reportId: 'abc', n: 'two' }, { idempotencyKey: 'k' })).rejects.toThrow();
    await expect(enqueueJob(d, echo, { reportId: 'has space', n: 1 }, { idempotencyKey: 'k' })).rejects.toThrow('short string');
    await expect(enqueueJob(d, echo, { reportId: 'abc', n: 1, extra: 1 }, { idempotencyKey: 'k' })).rejects.toThrow();
    expect(d.query).not.toHaveBeenCalled();
  });
});
