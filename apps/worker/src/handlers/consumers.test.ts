import { describe, expect, it } from 'vitest';
import { JobError, type ClaimedJob } from '@telesphoros/jobs';
import type { HandlerDeps, InspectedFile, JobData, ObjectInspector, VerifyOutcome, VerifyTarget } from '../deps';
import { silentLogger } from '../log';
import type { HandlerContext, RegisteredJob } from '../runner';
import { filesVerifyJobs } from './files-verify';
import { uploadsSweepJob } from './uploads-sweep';

const SHA = 'a'.repeat(64);
const target = (over: Partial<VerifyTarget> = {}): VerifyTarget => ({ reportId: '11111111-1111-4111-8111-111111111111', storageKey: 'reports/x/y', objectVersion: 'v1', sha256: SHA, sizeBytes: 100, contentType: 'text/x-vcf', ...over });
const job = (type: string): ClaimedJob => ({ id: '22222222-2222-4222-8222-222222222222', tenantId: 't', type, payload: {}, attempt: 1, maxAttempts: 5, leaseUntil: new Date(), requestedBy: 'system:outbox' });

class FakeData implements JobData {
  recorded: { jobId: string; workerId: string; reportId: string; outcome: VerifyOutcome; reason: string | undefined; version: string }[] = [];
  targets: VerifyTarget[] = [];
  single: VerifyTarget | undefined;
  swept: string[] = [];
  async verifyTarget() { return this.single; }
  async verifyStale() { return this.targets; }
  async recordVerification(jobId: string, workerId: string, reportId: string, outcome: VerifyOutcome, reason: string | undefined, version: string) { this.recorded.push({ jobId, workerId, reportId, outcome, reason, version }); }
  async sweepUploads(jobId: string) { this.swept.push(jobId); return { released: 2, releasedBytes: 300, objectsKept: 1 }; }
}
const inspector = (result: InspectedFile | 'missing' | 'too-large' | Error): ObjectInspector => ({ inspect: async () => { if (result instanceof Error) throw result; return result; } });
/** A read that dies because the job was told to stop: the signal is aborted and the read then fails, as a timeout, a shutdown or a lost lease does. */
const abortingInspector = (controller: AbortController, after: 'fail' | 'finish' = 'fail'): ObjectInspector => ({
  inspect: async () => {
    controller.abort();
    if (after === 'fail') throw Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
    return ok;
  },
});
const logged: { level: string; event: string; fields?: unknown }[] = [];
const capture: HandlerDeps['log'] = (level, event, fields) => { logged.push({ level, event, fields }); };
const ok: InspectedFile = { sizeBytes: 100, sha256: SHA, contentType: 'text/x-vcf' };
const run = (jobs: RegisteredJob[], type: string, signal = new AbortController().signal) => jobs.find((j) => j.definition.type === type)!.handler({ job: job(type), actor: `system:${type}`, workerId: 'w1', signal } as HandlerContext);
const make = (data: FakeData, found: Parameters<typeof inspector>[0]) => { const deps: HandlerDeps = { data, inspector: inspector(found), log: silentLogger }; return filesVerifyJobs(deps); };
const rejection = async (p: Promise<void>) => p.then(() => undefined, (e: unknown) => e as JobError);

describe('files.verify-stored', () => {
  it('names the request that caused the check in its log line when the job carries one, and says nothing about it when it does not', async () => {
    const data = new FakeData(); data.single = target();
    const jobs = filesVerifyJobs({ data, inspector: inspector(ok), log: capture });
    const handler = jobs.find((j) => j.definition.type === 'files.verify-stored')!.handler;
    const withRequest = { ...job('files.verify-stored'), payload: { reportId: target().reportId, requestId: '33333333-3333-4333-8333-333333333333' } };
    logged.length = 0;
    await handler({ job: withRequest, actor: 'system:files.verify-stored', workerId: 'w1', signal: new AbortController().signal } as HandlerContext);
    await handler({ job: job('files.verify-stored'), actor: 'system:files.verify-stored', workerId: 'w1', signal: new AbortController().signal } as HandlerContext);
    const lines = logged.filter((l) => l.event === 'file-verified').map((l) => l.fields as Record<string, unknown>);
    expect(lines[0]).toMatchObject({ requestId: '33333333-3333-4333-8333-333333333333' });
    expect(lines[1]!.requestId).toBeUndefined(); // (the logger drops an undefined field, so no key is written)
  });
  it('does not record a finding, and does not raise the alarm line, when the read was cut short by an abort (the job is retried)', async () => {
    logged.length = 0;
    const data = new FakeData(); data.single = target();
    const controller = new AbortController();
    const jobs = filesVerifyJobs({ data, inspector: abortingInspector(controller), log: capture });
    const error = await rejection(run(jobs, 'files.verify-stored', controller.signal));
    expect(error).toMatchObject({ code: 'handler-aborted', retryable: true });
    expect(data.recorded).toEqual([]); // the record is append-only: an abort must not leave an `unreadable` row behind
    expect(logged.some((l) => l.event === 'file-verified')).toBe(false);
  });
  it('still records a read that completed, even if the job is told to stop right after (control: the guard looks at the failure, not at the signal alone)', async () => {
    const data = new FakeData(); data.single = target();
    const controller = new AbortController();
    await run(filesVerifyJobs({ data, inspector: abortingInspector(controller, 'finish'), log: silentLogger }), 'files.verify-stored', controller.signal);
    expect(data.recorded).toMatchObject([{ outcome: 'ok' }]);
  });
  it('records ok and succeeds for a file that matches what the report is pinned to', async () => {
    const data = new FakeData(); data.single = target();
    await run(make(data, ok), 'files.verify-stored');
    expect(data.recorded).toEqual([{ jobId: job('x').id, workerId: 'w1', reportId: target().reportId, outcome: 'ok', reason: undefined, version: 'v1' }]);
  });
  it('does nothing when the report has no uploaded file any more', async () => {
    const data = new FakeData();
    await run(make(data, ok), 'files.verify-stored');
    expect(data.recorded).toEqual([]);
  });
  it.each([
    ['a missing version', 'missing' as const, 'missing', 'version-missing', 'file-missing'],
    ['an object larger than the report says', 'too-large' as const, 'changed', 'size-mismatch', 'file-changed'],
    ['a different size', { ...ok, sizeBytes: 99 }, 'changed', 'size-mismatch', 'file-changed'],
    ['different bytes', { ...ok, sha256: 'b'.repeat(64) }, 'changed', 'hash-mismatch', 'file-changed'],
    ['a different content type', { ...ok, contentType: 'application/json' }, 'changed', 'type-mismatch', 'file-changed'],
    ['no content type', { ...ok, contentType: undefined }, 'changed', 'type-mismatch', 'file-changed'],
  ])('records %s as a finding and ends the job dead at once', async (_name, found, outcome, reason, code) => {
    const data = new FakeData(); data.single = target();
    const error = await rejection(run(make(data, found), 'files.verify-stored'));
    expect(error).toBeInstanceOf(JobError);
    expect(error).toMatchObject({ code, retryable: false });
    expect(data.recorded).toMatchObject([{ outcome, reason }]);
  });
  it('treats a read failure as retryable, records it, and never lets the store\'s message reach the record', async () => {
    const data = new FakeData(); data.single = target();
    const error = await rejection(run(make(data, new Error('connect ECONNREFUSED 10.0.0.1 patient Jane')), 'files.verify-stored'));
    expect(error).toMatchObject({ code: 'storage-unreadable', retryable: true });
    expect(data.recorded).toMatchObject([{ outcome: 'unreadable', reason: 'storage-error' }]);
    expect(JSON.stringify(data.recorded)).not.toContain('Jane');
  });
  it('accepts a content type that differs only in parameters or case', async () => {
    const data = new FakeData(); data.single = target({ contentType: 'text/x-vcf' });
    await run(make(data, { ...ok, contentType: 'Text/X-VCF; charset=utf-8' }), 'files.verify-stored');
    expect(data.recorded[0]!.outcome).toBe('ok');
  });
});

describe('files.verify-stale', () => {
  it('records nothing for a report whose read was cut short by an abort, and stops with a retryable error', async () => {
    const data = new FakeData(); data.targets = [target(), target({ reportId: '66666666-6666-4666-8666-666666666666' })];
    const controller = new AbortController();
    const error = await rejection(run(filesVerifyJobs({ data, inspector: abortingInspector(controller), log: silentLogger }), 'files.verify-stale', controller.signal));
    expect(error).toMatchObject({ code: 'handler-aborted', retryable: true });
    expect(data.recorded).toEqual([]);
  });
  it('checks each report it is given and succeeds when all are clean', async () => {
    const data = new FakeData(); data.targets = [target({ reportId: '33333333-3333-4333-8333-333333333333' }), target({ reportId: '44444444-4444-4444-8444-444444444444' })];
    await run(make(data, ok), 'files.verify-stale');
    expect(data.recorded.map((r) => r.reportId)).toEqual(data.targets.map((t) => t.reportId));
    expect(data.recorded.every((r) => r.outcome === 'ok')).toBe(true);
  });
  it('checks them all, records every finding, and then ends the job dead', async () => {
    const data = new FakeData(); data.targets = [target(), target({ reportId: '55555555-5555-4555-8555-555555555555' })];
    const error = await rejection(run(make(data, 'missing'), 'files.verify-stale'));
    expect(error).toMatchObject({ code: 'file-missing', retryable: false });
    expect(data.recorded).toHaveLength(2);
  });
  it('stops, retryably, when it is told to (the next run takes the unchecked first)', async () => {
    const data = new FakeData(); data.targets = [target(), target()];
    const abort = new AbortController(); abort.abort();
    const error = await rejection(run(make(data, ok), 'files.verify-stale', abort.signal));
    expect(error).toMatchObject({ code: 'handler-aborted', retryable: true });
    expect(data.recorded).toEqual([]);
  });
});

describe('uploads.sweep', () => {
  it('asks the database to sweep the organization of the job it holds, naming the job and the worker', async () => {
    const data = new FakeData();
    await run([uploadsSweepJob({ data, inspector: inspector(ok), log: silentLogger })], 'uploads.sweep');
    expect(data.swept).toEqual([job('x').id]);
  });
});
