import { Body, Controller, Get, Post, Res } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { Logger, LoggerModule } from 'nestjs-pino';
import { z } from 'zod';
import { ZodValidationPipe } from '../src/common/zod-validation.pipe';
import type { Response } from 'express';
import { Writable } from 'node:stream';
import request from 'supertest';
import { configureApp } from '../src/app.factory';
import { InputBoundaryInterceptor } from '../src/common/input-boundary.interceptor';
import { AllExceptionsFilter } from '../src/common/all-exceptions.filter';
import { pinoHttpOptions } from '../src/logger-options';

const MARKER = 'SYNTHETIC-PRIVATE-MARKER';
@Controller('privacy')
class PrivacyFaultsController {
  @Post()
  body(
    @Body(new ZodValidationPipe(z.strictObject({ value: z.string() })))
    input: {
      value: string;
    },
  ) {
    throw new Error(input.value);
  }

  @Get('transport')
  transport(@Res({ passthrough: true }) res: Response & { err?: Error }) {
    res.err = new Error(MARKER);
    return { status: 'synthetic' };
  }

  @Get(':id')
  crash() {
    throw Object.assign(new Error(MARKER, { cause: new Error(MARKER) }), {
      detail: MARKER,
      query: MARKER,
      credentials: MARKER,
    });
  }
}

it('keeps exception contents and request values out of real filter and HTTP JSON logs', async () => {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, done) {
      chunks.push(chunk.toString());
      done();
    },
  });
  const moduleRef = await Test.createTestingModule({
    imports: [
      LoggerModule.forRoot({
        pinoHttp: [pinoHttpOptions({ LOG_LEVEL: 'info' }), stream],
      }),
    ],
    controllers: [PrivacyFaultsController],
    providers: [
      { provide: APP_FILTER, useClass: AllExceptionsFilter },
      { provide: APP_INTERCEPTOR, useClass: InputBoundaryInterceptor },
    ],
  }).compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>();
  app.useLogger(app.get(Logger));
  configureApp(app);
  await app.listen(0);
  try {
    await request(app.getHttpServer()).get('/api/v1/privacy/transport').expect(200);
    const res = await request(app.getHttpServer())
      .get(`/api/v1/privacy/${MARKER}`)
      .set('Authorization', `Bearer ${MARKER}`)
      .set('Cookie', `session=${MARKER}`)
      .expect(500);
    await request(app.getHttpServer()).get(`/api/v1/privacy/${MARKER}?secret=${MARKER}`).expect(400);
    await request(app.getHttpServer()).post('/api/v1/privacy').send({ value: MARKER }).expect(500);
    const rejected = await request(app.getHttpServer())
      .post('/api/v1/privacy')
      .send({ value: 'ok', [MARKER]: MARKER })
      .expect(400);
    expect(JSON.stringify(rejected.body)).not.toContain(MARKER);
    const missing = await request(app.getHttpServer()).get(`/api/v1/missing/${MARKER}`).expect(404);
    expect(JSON.stringify([res.body, missing.body])).not.toContain(MARKER);
  } finally {
    await app.close();
  }
  const raw = chunks.join('');
  expect(raw).not.toContain(MARKER);
  const lines = raw
    .split('\n')
    .filter(Boolean)
    .map((s) => JSON.parse(s) as Record<string, unknown>);
  expect(lines).toContainEqual(
    expect.objectContaining({
      event: 'api-error',
      status: 500,
      code: 'INTERNAL_ERROR',
      requestId: expect.any(String),
    }),
  );
  const http = lines.filter((s) => s.req);
  expect(http.length).toBeGreaterThanOrEqual(2);
  expect(http.map((s) => s.route)).toContain('/api/v1/privacy/:id');
  expect(http.map((s) => s.route)).toContain('[unmatched]');
});
