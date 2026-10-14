import { describe, expect, it } from 'vitest';
import { jsonLogger } from './log';

describe('the log', () => {
  it('writes one JSON line per event with only the fixed fields', () => {
    const lines: string[] = [];
    jsonLogger((l) => lines.push(l))('info', 'job-finished', { jobId: 'abc-1', jobType: 'uploads.sweep', attempt: 2, outcome: 'succeeded' });
    expect(JSON.parse(lines[0]!)).toMatchObject({ level: 'info', service: 'worker', event: 'job-finished', jobId: 'abc-1', jobType: 'uploads.sweep', attempt: 2, outcome: 'succeeded' });
  });
  it('drops any string that is not a short code, so a message or a value cannot be logged', () => {
    const lines: string[] = [];
    const log = jsonLogger((l) => lines.push(l));
    log('error', 'x', { code: 'patient Jane Doe has CYP2D6 *4/*4', reason: 'a'.repeat(200), jobId: 'ok-1' });
    const out = JSON.parse(lines[0]!);
    expect(out.code).toBeUndefined();
    expect(out.reason).toBeUndefined();
    expect(out.jobId).toBe('ok-1');
    expect(lines[0]).not.toContain('Jane');
  });
});
