import { Logger as NestLogger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Logger, LoggerModule } from 'nestjs-pino';
import { Writable } from 'node:stream';
import { pinoHttpOptions } from './logger-options';

// nestjs-pino builds its root logger ONCE per process, on the first LoggerModule, and every later module reuses it with that first stream. So all
// tests in this file share one stream, emptied at the start of each capture.
const lines: string[] = [];
const stream = new Writable({
  write(chunk: Buffer, _encoding, done) {
    lines.push(chunk.toString('utf8'));
    done();
  },
});
const parse = (raw: string) =>
  raw
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);

async function capture(write: (log: NestLogger) => void): Promise<{ entries: Array<Record<string, unknown>>; raw: string }> {
  lines.length = 0;
  const moduleRef = await Test.createTestingModule({ imports: [LoggerModule.forRoot({ pinoHttp: [pinoHttpOptions({ LOG_LEVEL: 'info' }), stream] })] }).compile();
  const app = moduleRef.createNestApplication();
  app.useLogger(app.get(Logger));
  await app.init();
  write(new NestLogger('LedgerMonitor'));
  await app.close();
  const raw = lines.join('');
  return { entries: parse(raw), raw };
}

/**
 * The contract between the application and the `ledger-compromised` alarm (infrastructure/terraform/api-compute.tf): a CloudWatch Logs metric
 * filter reads each log line as JSON and matches a top-level `event` field. The monitor logs through Nest's Logger with an object
 * (ledger-monitor.ts), and the application routes Nest's Logger to nestjs-pino (main.ts: app.useLogger). This pins what that combination writes,
 * so a change to the logger setup that would nest or rename the field (and silently stop the alarm) fails here instead.
 */
describe('log line shape (the alarm contract)', () => {
  it("writes an object logged through Nest's Logger as one JSON line with the fields at the top level (and only the named event matches)", async () => {
    const { entries: out } = await capture((log) => {
      log.error({ event: 'something-else', message: 'x' }); // control: another event must not look like the alarm's
      log.error({
        event: 'ledger-compromised',
        source: 'timer',
        tenantId: 'tenant-1',
        mode: 'full',
        eventsChecked: 3,
        failures: [{ kind: 'hash', seq: 7 }],
        message: 'The record log failed verification.',
      });
    });
    const matching = out.filter((entry) => entry.event === 'ledger-compromised');
    expect(matching).toHaveLength(1);
    expect(matching[0]).toMatchObject({
      event: 'ledger-compromised',
      source: 'timer',
      tenantId: 'tenant-1',
      mode: 'full',
      eventsChecked: 3,
      failures: [{ kind: 'hash', seq: 7 }],
      level: 50,
    });
    expect(out.some((entry) => entry.event === 'something-else')).toBe(true);
  });
});

/**
 * Audit finding INF-10: the API's log lines are projected through an ALLOWLIST of field names (logger-options.ts), as the worker's are
 * (apps/worker/src/log.ts). A field nobody listed is dropped, and only its NAME is kept (`droppedFields`) so the omission is visible. An error
 * keeps its class, code and stack frames, never its message: driver and SDK messages can carry values, host names or user names.
 */
describe('log line projection (no field nobody listed, no error message)', () => {
  it('drops a field that is not on the allowlist, and names it', async () => {
    const { entries, raw } = await capture((log) => log.warn({ event: 'probe', reason: 'none', patientName: 'Jane Synthetic', dob: '1970-01-01' }));
    const line = entries.find((entry) => entry.event === 'probe');
    expect(line).toMatchObject({ event: 'probe', reason: 'none', droppedFields: ['patientName', 'dob'] });
    expect(line).not.toHaveProperty('patientName');
    expect(raw).not.toContain('Jane Synthetic');
    expect(raw).not.toContain('1970-01-01');
  });

  it("keeps an error's class, code and frames, but not its message (Nest's Logger.error(message, stack) form)", async () => {
    const error = Object.assign(new Error('duplicate key value (mrn)=(SYN-0042) for owner@example.test'), { code: '23505' });
    const { entries, raw } = await capture((log) => log.error(error.message, error.stack));
    expect(raw).not.toContain('SYN-0042');
    expect(raw).not.toContain('owner@example.test');
    const line = entries.find((entry) => entry.err !== undefined);
    expect(line?.err).toMatchObject({ type: 'Error' });
    expect(Array.isArray((line?.err as { frames?: unknown }).frames)).toBe(true);
    expect((line?.err as { frames: string[] }).frames.every((frame) => frame.startsWith('at '))).toBe(true);
    expect(line?.msg).toBe('Error'); // the line's text is replaced too: in this form it IS the message
  });

  it('reduces an Error object under any allowed field to its class and code', async () => {
    const error = Object.assign(new Error('connect ECONNREFUSED db.internal.example:5432 as telesphoros_admin'), { code: 'ECONNREFUSED' });
    const { entries, raw } = await capture((log) => log.error({ event: 'probe-error', error }));
    expect(raw).not.toContain('db.internal.example');
    expect(raw).not.toContain('telesphoros_admin');
    expect(entries.find((entry) => entry.event === 'probe-error')).toMatchObject({ error: { type: 'Error', code: 'ECONNREFUSED' } });
  });

  it('keeps the fields pino-http writes for a real request', async () => {
    lines.length = 0;
    const moduleRef = await Test.createTestingModule({ imports: [LoggerModule.forRoot({ pinoHttp: [pinoHttpOptions({ LOG_LEVEL: 'info' }), stream] })] }).compile();
    const app = moduleRef.createNestApplication();
    app.useLogger(app.get(Logger));
    await app.listen(0, '127.0.0.1');
    try {
      const port = (app.getHttpServer().address() as { port: number }).port;
      // No route is mounted: the 404 is still a real request through the real logging middleware. No keep-alive socket is left to hold close().
      expect((await fetch(`http://127.0.0.1:${port}/probe`, { headers: { connection: 'close' } })).status).toBe(404);
      // pino-http writes the line when the response finishes, which can be just after the client has it.
      for (let i = 0; i < 50 && !lines.join('').includes('"res"'); i++) await new Promise((resolve) => setTimeout(resolve, 20));
    } finally {
      await app.close();
    }
    const request = parse(lines.join('')).find((entry) => entry.res !== undefined);
    expect(request).toMatchObject({ res: { statusCode: 404 }, req: { method: 'GET' }, route: '[unmatched]' });
    expect(typeof request?.responseTime).toBe('number');
    expect(request).not.toHaveProperty('droppedFields');
  });
});
