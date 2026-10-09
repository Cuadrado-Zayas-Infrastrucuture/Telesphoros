import { Logger as NestLogger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Logger, LoggerModule } from 'nestjs-pino';
import { Writable } from 'node:stream';
import { pinoHttpOptions } from './logger-options';

/**
 * The contract between the application and the `ledger-compromised` alarm (infrastructure/terraform/api-compute.tf): a CloudWatch Logs metric
 * filter reads each log line as JSON and matches a top-level `event` field. The monitor logs through Nest's Logger with an object
 * (ledger-monitor.ts), and the application routes Nest's Logger to nestjs-pino (main.ts: app.useLogger). This pins what that combination writes,
 * so a change to the logger setup that would nest or rename the field (and silently stop the alarm) fails here instead.
 */
describe('log line shape (the alarm contract)', () => {
  async function capture(write: (log: NestLogger) => void): Promise<Array<Record<string, unknown>>> {
    const lines: string[] = [];
    const stream = new Writable({
      write(chunk: Buffer, _encoding, done) {
        lines.push(chunk.toString('utf8'));
        done();
      },
    });
    const moduleRef = await Test.createTestingModule({ imports: [LoggerModule.forRoot({ pinoHttp: [pinoHttpOptions({ LOG_LEVEL: 'info' }), stream] })] }).compile();
    const app = moduleRef.createNestApplication();
    app.useLogger(app.get(Logger));
    await app.init();
    write(new NestLogger('LedgerMonitor'));
    await app.close();
    return lines.flatMap((chunk) => chunk.split('\n')).filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
  }

  it('writes an object logged through Nest\'s Logger as one JSON line with the fields at the top level (and only the named event matches)', async () => {
    const out = await capture((log) => {
      log.error({ event: 'something-else', message: 'x' }); // control: another event must not look like the alarm's
      log.error({ event: 'ledger-compromised', source: 'timer', tenantId: 'tenant-1', mode: 'full', eventsChecked: 3, message: 'The record log failed verification.' });
    });
    const matching = out.filter((entry) => entry.event === 'ledger-compromised');
    expect(matching).toHaveLength(1);
    expect(matching[0]).toMatchObject({ event: 'ledger-compromised', source: 'timer', tenantId: 'tenant-1', level: 50 });
    expect(out.some((entry) => entry.event === 'something-else')).toBe(true);
  });
});
