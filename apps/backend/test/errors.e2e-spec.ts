import { BadRequestException, Controller, Get } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { ErrorCode, errorResponseSchema } from '@telesphoros/shared-types';
import request from 'supertest';
import { Public } from '../src/auth/decorators';
import { createTestApp, FaultsController } from './helpers/app';
import { bearer, clinicianA } from './helpers/tokens';

@Controller('test-foreign')
class ForeignExceptionController {
  @Public()
  @Get('http')
  http() {
    throw new BadRequestException('internal detail: table users column ssn');
  }
}

let app: NestExpressApplication;
beforeAll(async () => {
  app = await createTestApp({ controllers: [FaultsController, ForeignExceptionController] });
});
afterAll(async () => {
  await app.close();
});

const api = () => request(app.getHttpServer());

describe('one error contract for every failure', () => {
  it('unknown routes: 404 NOT_FOUND in the standard envelope', async () => {
    const res = await api().get('/api/v1/nothing-here').set(bearer(await clinicianA())).expect(404);
    expect(errorResponseSchema.safeParse(res.body).success).toBe(true);
    expect(res.body.error.code).toBe(ErrorCode.NOT_FOUND);
  });

  it('unhandled errors: generic 500 INTERNAL_ERROR, nothing internal leaks', async () => {
    for (const path of ['crash', 'type-error']) {
      const res = await api().get(`/api/v1/test-faults/${path}`).expect(500);
      expect(errorResponseSchema.safeParse(res.body).success).toBe(true);
      expect(res.body.error.code).toBe(ErrorCode.INTERNAL_ERROR);
      const raw = JSON.stringify(res.body) + res.text;
      expect(raw).not.toMatch(/hunter2|secret-file|\/srv\/|stack|at Object|TypeError|node_modules/);
    }
  });

  it('foreign HttpExceptions: the framework message is replaced by a safe generic one', async () => {
    const res = await api().get('/api/v1/test-foreign/http').expect(400);
    expect(res.body.error.code).toBe(ErrorCode.BAD_REQUEST);
    expect(JSON.stringify(res.body)).not.toMatch(/ssn|users|internal detail/);
  });

  it('malformed JSON: 400 BAD_REQUEST, not an HTML error page', async () => {
    const res = await api()
      .post('/api/v1/patients')
      .set(bearer(await clinicianA()))
      .set('Content-Type', 'application/json')
      .send('{"label": ')
      .expect(400);
    expect(res.headers['content-type']).toMatch(/json/);
    expect(errorResponseSchema.safeParse(res.body).success).toBe(true);
    expect(res.body.error.code).toBe(ErrorCode.BAD_REQUEST);
  });

  it('oversize body (over 100 kB): 413 PAYLOAD_TOO_LARGE', async () => {
    const res = await api()
      .post('/api/v1/patients')
      .set(bearer(await clinicianA()))
      .send({ label: 'x'.repeat(150_000) })
      .expect(413);
    expect(res.body.error.code).toBe(ErrorCode.PAYLOAD_TOO_LARGE);
  });

  it('does not advertise the framework', async () => {
    const res = await api().get('/api/v1/health').expect(200);
    expect(res.headers['x-powered-by']).toBeUndefined();
  });
});

describe('request id', () => {
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

  it('is generated for every response, including errors and 404s, and matches the error body', async () => {
    const ok = await api().get('/api/v1/health').expect(200);
    expect(ok.headers['x-request-id']).toMatch(UUID);

    const err = await api().get('/api/v1/patients').expect(401);
    expect(err.headers['x-request-id']).toMatch(UUID);
    expect(err.body.error.requestId).toBe(err.headers['x-request-id']);

    const missing = await api().get('/nope').expect(404);
    expect(missing.body.error.requestId).toBe(missing.headers['x-request-id']);
  });

  it('a path outside /api, for any method, gets the same JSON envelope and request id (not Express\'s HTML 404)', async () => {
    for (const [method, path] of [['get', '/'], ['get', '/nope'], ['post', '/nope'], ['put', '/health'], ['delete', '/apiary'], ['get', '/apiary/v1']] as const) {
      const res = await api()[method](path).expect(404);
      expect(res.headers['content-type']).toMatch(/json/);
      expect(errorResponseSchema.safeParse(res.body).success).toBe(true);
      expect(res.body.error.code).toBe(ErrorCode.NOT_FOUND);
      expect(res.body.error.requestId).toBe(res.headers['x-request-id']);
      expect(res.text).not.toContain('Cannot'); // Express's default page names the method and path
    }
  });

  it('echoes a safe caller-supplied id so a frontend can correlate its own request', async () => {
    const res = await api().get('/api/v1/patients').set('X-Request-Id', 'frontend-req-12345').expect(401);
    expect(res.headers['x-request-id']).toBe('frontend-req-12345');
    expect(res.body.error.requestId).toBe('frontend-req-12345');
  });

  it.each(['short', 'has spaces in it!', 'x'.repeat(65), '<script>alert(1)</script>'])(
    'replaces an unsafe caller-supplied id (%s)',
    async (unsafe) => {
      const res = await api().get('/api/v1/health').set('X-Request-Id', unsafe).expect(200);
      expect(res.headers['x-request-id']).toMatch(UUID);
    },
  );
});
