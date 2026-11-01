import { ReportsController } from '../src/reports/reports.controller';
import { Controller, Get, HttpCode, Post } from '@nestjs/common';
import { METHOD_METADATA } from '@nestjs/common/constants';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { errorResponseSchema } from '@telesphoros/shared-types';
import request from 'supertest';
import { Public, Roles } from '../src/auth/decorators';
import { CapturesController, ReportCaptureController } from '../src/lab-reports/captures.controller';
import { ReportEvaluationController } from '../src/lab-reports/evaluations.controller';
import { LedgerController } from '../src/ledger/ledger.controller';
import { RATE_CLASS_KEY, RateLimitClass, SkipRateLimit } from '../src/rate-limit/rate-limit.decorators';
import { createTestApp } from './helpers/app';
import { bearer, signToken } from './helpers/tokens';

// Rate limiting over HTTP (slice F2): the 429 shape, route classes, who shares a bucket and who does not, where the limits sit around
// authentication, the exempt probes, and how the client address is read. Synthetic data only.

@Controller('rl-test')
class RateTestController {
  @Get('read') read() {
    return { ok: true };
  }
  @Post('write') @HttpCode(200) write() {
    return { ok: true };
  }
  @Get('expensive') @RateLimitClass('expensive') expensive() {
    return { ok: true };
  }
  @Get('admin') @Roles('admin') admin() {
    return { ok: true };
  }
  @Public() @Get('open') open() {
    return { ok: true };
  }
  @Public() @SkipRateLimit() @Get('skipped') skipped() {
    return { ok: true };
  }
}

const PREFIX = '/api/v1/rl-test';
const person = (sub: string, tenant = `tenant-${sub}`, roles: string[] = ['reader', 'clinician']) => signToken({ sub, tenant, roles });
let open: NestExpressApplication | undefined;
async function start(options: Parameters<typeof createTestApp>[0] = {}) {
  open = await createTestApp({ controllers: [RateTestController], ...options });
  return open;
}
afterEach(async () => {
  await open?.close();
  open = undefined;
});
const get = (app: NestExpressApplication, path: string, token?: string, headers: Record<string, string> = {}) => {
  const call = request(app.getHttpServer()).get(`${PREFIX}${path}`).set(headers);
  return token ? call.set(bearer(token)) : call;
};
const statuses = async (n: number, send: () => request.Test) => {
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push((await send()).status);
  return out;
};

describe('the 429 answer', () => {
  it('is RATE_LIMITED in the standard error envelope with a whole-second Retry-After, a request id, and no hint of which limit was hit', async () => {
    const app = await start({ rateLimit: { ip: 1000, read: 2 } });
    const token = await person('p1');
    await get(app, '/read', token).expect(200);
    await get(app, '/read', token).expect(200);
    const res = await get(app, '/read', token).expect(429);
    expect(errorResponseSchema.safeParse(res.body).success).toBe(true);
    expect(res.body.error).toMatchObject({ code: 'RATE_LIMITED', message: 'Too many requests. Try again shortly.' });
    expect(res.body.error.details).toBeUndefined();
    expect(res.headers['retry-after']).toMatch(/^[1-9]\d*$/);
    expect(res.headers['x-request-id']).toBeTruthy();
    expect(JSON.stringify(res.body)).not.toMatch(/tenant|p1|read|ip/i);
  });
});

describe('route classes', () => {
  it('exposes the retry delay to an allowed browser origin on a real 429', async () => {
    const origin = 'https://app.example.test';
    const app = await start({ corsOrigins: [origin], rateLimit: { ip: 1000, read: 1 } });
    const token = await person('browser');
    await get(app, '/read', token, { Origin: origin }).expect(200);
    const limited = await get(app, '/read', token, { Origin: origin }).expect(429);
    expect(limited.headers['retry-after']).toMatch(/^[1-9]\d*$/);
    expect(limited.headers['access-control-allow-origin']).toBe(origin);
    expect(limited.headers['access-control-expose-headers'].split(',').map((h: string) => h.trim().toLowerCase())).toContain('retry-after');
    const foreign = await get(app, '/read', token, { Origin: 'https://other.example.test' });
    expect(foreign.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('reads, writes and expensive routes have separate buckets per person, with their own limits', async () => {
    const app = await start({ rateLimit: { ip: 1000, read: 3, write: 2, expensive: 1 } });
    const token = await person('p1');
    const write = () => request(app.getHttpServer()).post(`${PREFIX}/write`).set(bearer(token));
    expect(await statuses(4, () => get(app, '/read', token))).toEqual([200, 200, 200, 429]);
    expect(await statuses(3, write)).toEqual([200, 200, 429]);
    expect(await statuses(2, () => get(app, '/expensive', token))).toEqual([200, 429]);
  });

  it('the real expensive routes are marked expensive (a hand-written list, so a route that loses its mark is noticed)', () => {
    const marked = (controller: { prototype: object }, handler: string) => Reflect.getMetadata(RATE_CLASS_KEY, (controller.prototype as Record<string, object>)[handler]);
    expect([
      marked(ReportCaptureController, 'capture'),
      marked(ReportsController, 'downloadUrl'),
      marked(CapturesController, 'textUrl'),
      marked(ReportEvaluationController, 'create'),
      marked(LedgerController, 'verify'),
    ]).toEqual(['expensive', 'expensive', 'expensive', 'expensive', 'expensive']);
    // Control: a route that is not marked is not expensive.
    expect(marked(CapturesController, 'get')).toBeUndefined();
    expect(Reflect.getMetadata(METHOD_METADATA, CapturesController.prototype.get)).toBeDefined();
  });
});

describe('who shares a bucket', () => {
  it('two people in one tenant do not limit each other, and the same individual id in two tenants is two people', async () => {
    const app = await start({ rateLimit: { ip: 1000, read: 2 } });
    const a = await person('p1', 'tenant-1');
    const b = await person('p2', 'tenant-1');
    const aElsewhere = await person('p1', 'tenant-2');
    expect(await statuses(3, () => get(app, '/read', a))).toEqual([200, 200, 429]);
    await get(app, '/read', b).expect(200);
    await get(app, '/read', aElsewhere).expect(200);
  });

  it('is not defeated by minting a new token: the person, not the token, is the key', async () => {
    const app = await start({ rateLimit: { ip: 1000, read: 2 } });
    await get(app, '/read', await person('p1')).expect(200);
    await get(app, '/read', await person('p1')).expect(200);
    await get(app, '/read', await person('p1')).expect(429);
  });
});

describe('where the limits sit around authentication', () => {
  it('the address limit comes BEFORE authentication: a flood of unauthenticated requests is turned away with 429, not 401', async () => {
    const app = await start({ rateLimit: { ip: 2, read: 1000 } });
    expect(await statuses(4, () => get(app, '/read'))).toEqual([401, 401, 429, 429]);
  });

  it("an unauthenticated or refused request never spends a person's tokens", async () => {
    const app = await start({ rateLimit: { ip: 1000, read: 2 } });
    const reader = await person('p1', 'tenant-1', ['reader']);
    // A reader is refused 403 on the admin route, five times; and bad tokens are refused 401 five times. None of that is the person's budget.
    expect(await statuses(5, () => get(app, '/admin', reader))).toEqual([403, 403, 403, 403, 403]);
    expect(await statuses(5, () => get(app, '/read', 'not-a-token'))).toEqual([401, 401, 401, 401, 401]);
    expect(await statuses(3, () => get(app, '/read', reader))).toEqual([200, 200, 429]);
  });

  it('a public route (no person) is limited by address only', async () => {
    const app = await start({ rateLimit: { ip: 3, read: 1 } });
    expect(await statuses(4, () => get(app, '/open'))).toEqual([200, 200, 200, 429]);
  });
});

describe('exempt probes', () => {
  it('health and ready are never limited, while an ordinary route from the same address is (control)', async () => {
    const app = await start({ rateLimit: { ip: 1 } });
    const probe = (path: string) => request(app.getHttpServer()).get(`/api/v1/${path}`);
    expect(await statuses(6, () => probe('health'))).toEqual([200, 200, 200, 200, 200, 200]);
    expect(await statuses(3, () => probe('ready'))).toEqual([200, 200, 200]);
    expect(await statuses(2, () => get(app, '/open'))).toEqual([200, 429]);
    await get(app, '/skipped').expect(200);
  });
});

describe('the client address', () => {
  it('ignores X-Forwarded-For by default: a client cannot escape the address limit with a header it controls', async () => {
    const app = await start({ rateLimit: { ip: 2 } });
    const codes = [];
    for (const forwarded of ['198.51.100.1', '198.51.100.2', '198.51.100.3', '198.51.100.4']) {
      codes.push((await get(app, '/open', undefined, { 'X-Forwarded-For': forwarded })).status);
    }
    expect(codes).toEqual([200, 200, 429, 429]);
  });

  it('with one trusted proxy, distinct forwarded clients get their own buckets', async () => {
    const app = await start({ rateLimit: { ip: 2 }, trustProxyHops: 1 });
    const from = (address: string) => get(app, '/open', undefined, { 'X-Forwarded-For': address });
    expect(await statuses(3, () => from('198.51.100.1'))).toEqual([200, 200, 429]);
    await from('198.51.100.2').expect(200);
  });

  it('with one trusted proxy, an address the CLIENT prepends is ignored: only the one the proxy appended counts', async () => {
    const app = await start({ rateLimit: { ip: 2 }, trustProxyHops: 1 });
    const codes = [];
    for (const forwarded of ['203.0.113.7, 198.51.100.9', '203.0.113.8, 198.51.100.9', '203.0.113.9, 198.51.100.9']) {
      codes.push((await get(app, '/open', undefined, { 'X-Forwarded-For': forwarded })).status);
    }
    expect(codes).toEqual([200, 200, 429]);
  });
});

describe('what a refused request does', () => {
  it('stores nothing: a write refused with 429 never reaches the handler', async () => {
    const app = await start({ rateLimit: { ip: 1000, read: 1000, write: 1 } });
    const token = await signToken({ sub: 'clin', tenant: 'tenant-clin', roles: ['clinician'] });
    const create = (label: string) => request(app.getHttpServer()).post('/api/v1/patients').set(bearer(token)).send({ label });
    await create('SYN-0001').expect(201);
    await create('SYN-0002').expect(429);
    const list = await request(app.getHttpServer()).get('/api/v1/patients').set(bearer(token)).expect(200);
    expect(list.body.data.map((p: { label: string }) => p.label)).toEqual(['SYN-0001']);
  });
});

describe('when it is off (the test default)', () => {
  it('never limits, however many requests are made (control: the same traffic is limited when it is on)', async () => {
    const off = await start();
    const token = await person('p1');
    const codes = await statuses(40, () => get(off, '/read', token));
    expect(new Set(codes)).toEqual(new Set([200]));
  });
});
