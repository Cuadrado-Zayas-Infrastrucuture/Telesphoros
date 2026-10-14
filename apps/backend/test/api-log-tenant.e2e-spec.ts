import { Controller, Get } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { Logger, LoggerModule } from 'nestjs-pino';
import { Writable } from 'node:stream';
import request from 'supertest';
import { configureApp } from '../src/app.factory';
import { AppException } from '../src/common/app-exception';
import { AllExceptionsFilter } from '../src/common/all-exceptions.filter';
import { InputBoundaryInterceptor } from '../src/common/input-boundary.interceptor';
import { AuthGuard } from '../src/auth/auth.guard';
import { Public } from '../src/auth/decorators';
import { InMemorySecurityAuditStore, SecurityAuditStore } from '../src/auth/security-audit';
import { TokenVerifier } from '../src/auth/token-verifier';
import { pinoHttpOptions } from '../src/logger-options';

/**
 * O02 (research audit): request-completion logs carried `userId` but no tenant, so an operator could not tell which organization a failing or
 * slow request belonged to. This drives the real AuthGuard, exception filter and pino-http options over a real HTTP request.
 */
@Controller('probe')
class ProbeController {
  @Get('ok')
  ok() {
    return { status: 'ok' };
  }

  @Get('missing')
  missing() {
    throw AppException.notFound();
  }

  @Public()
  @Get('open')
  open() {
    return { status: 'open' };
  }
}

const verifier: TokenVerifier = {
  verify: async (token) => {
    if (token !== 'good') throw new Error('bad token');
    return { sub: 'user-synthetic', tenantId: 'tenant-synthetic', roles: ['clinician'] };
  },
};

type Entry = Record<string, unknown>;
const chunks: string[] = [];
let app: NestExpressApplication;

// One app and one capture for the whole file: nestjs-pino keeps a process-wide root logger, so a second app in the same process would write to the first one's stream.
beforeAll(async () => {
  const stream = new Writable({
    write(chunk: Buffer, _encoding, done) {
      chunks.push(chunk.toString());
      done();
    },
  });
  const moduleRef = await Test.createTestingModule({
    imports: [LoggerModule.forRoot({ pinoHttp: [pinoHttpOptions({ LOG_LEVEL: 'info' }), stream] })],
    controllers: [ProbeController],
    providers: [
      { provide: TokenVerifier, useValue: verifier },
      { provide: SecurityAuditStore, useClass: InMemorySecurityAuditStore },
      { provide: APP_GUARD, useClass: AuthGuard },
      { provide: APP_FILTER, useClass: AllExceptionsFilter },
      { provide: APP_INTERCEPTOR, useClass: InputBoundaryInterceptor },
    ],
  }).compile();
  app = moduleRef.createNestApplication<NestExpressApplication>();
  app.useLogger(app.get(Logger));
  configureApp(app);
  await app.listen(0);
});
afterAll(async () => {
  await app.close();
});

/** The log lines written for one request, found by its request id (the completion line is written just after the response ends). */
async function logsFor(requestId: string): Promise<Entry[]> {
  await new Promise((resolve) => setTimeout(resolve, 25));
  return chunks
    .flatMap((chunk) => chunk.split('\n'))
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Entry)
    .filter((entry) => entry.requestId === requestId || (entry.req as { id?: string } | undefined)?.id === requestId);
}
const completion = (logs: Entry[]) => logs.find((entry) => entry.res !== undefined);
const idOf = (res: { headers: Record<string, unknown> }) => String(res.headers['x-request-id']);

describe('tenant correlation in request logs', () => {
  it('adds the tenant to the completion log of an authenticated request, next to the user id', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/probe/ok').set('Authorization', 'Bearer good').expect(200);
    expect(completion(await logsFor(idOf(res)))).toMatchObject({ userId: 'user-synthetic', tenantId: 'tenant-synthetic', route: '/api/v1/probe/ok' });
  });

  it('adds the tenant to the failure log lines of an authenticated request that is refused', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/probe/missing').set('Authorization', 'Bearer good').expect(404);
    const logs = await logsFor(idOf(res));
    expect(logs.find((entry) => entry.msg === 'Request rejected')).toMatchObject({ status: 404, tenantId: 'tenant-synthetic' });
    expect(completion(logs)).toMatchObject({ tenantId: 'tenant-synthetic' });
  });

  it('leaves the tenant out when nobody is authenticated, and never invents one from a request header', async () => {
    const open = await request(app.getHttpServer()).get('/api/v1/probe/open').set('X-Tenant-Id', 'tenant-from-header').expect(200);
    const refused = await request(app.getHttpServer()).get('/api/v1/probe/ok').set('Authorization', 'Bearer wrong').set('X-Tenant-Id', 'tenant-from-header').expect(401);
    for (const res of [open, refused]) {
      const logs = await logsFor(idOf(res));
      expect(completion(logs)).toBeDefined();
      for (const entry of logs) expect(entry).not.toHaveProperty('tenantId');
    }
    expect(chunks.join('')).not.toMatch(/tenant-from-header/);
  });
});
