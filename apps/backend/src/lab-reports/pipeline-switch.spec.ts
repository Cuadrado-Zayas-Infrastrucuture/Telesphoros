import { Controller, Get, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppException } from '../common/app-exception';
import { AllExceptionsFilter } from '../common/all-exceptions.filter';
import type { Env } from '../config/env';
import { InMemoryObjectStorage } from '../object-storage/in-memory-object-storage';
import { PinoLogger } from 'nestjs-pino';
import { PipelineGateGuard, PipelineStartupCheck, PipelineSwitch, REQUIRES_PIPELINE, RequiresPipeline } from './pipeline-switch';

const switchFor = (state: 'enabled' | 'disabled') => new PipelineSwitch({ LAB_REPORT_PIPELINE: state, DOWNLOAD_URL_TTL_SECONDS: 120 } as Env);

describe('PipelineSwitch', () => {
  it('throws PIPELINE_DISABLED only while disabled', () => {
    expect(() => switchFor('disabled').assertEnabled()).toThrow(AppException);
    expect(() => switchFor('enabled').assertEnabled()).not.toThrow();
  });
});

describe('PipelineStartupCheck', () => {
  it('does nothing while the pipeline is off, even on an unversioned store', async () => {
    const storage = new InMemoryObjectStorage();
    storage.versioned = false;
    await expect(new PipelineStartupCheck(switchFor('disabled'), storage).onApplicationBootstrap()).resolves.toBeUndefined();
  });

  it('refuses to start with the pipeline on and a store that keeps no versions', async () => {
    const storage = new InMemoryObjectStorage();
    storage.versioned = false;
    await expect(new PipelineStartupCheck(switchFor('enabled'), storage).onApplicationBootstrap()).rejects.toThrow(/keeps versions/);
  });

  it('starts with the pipeline on and a versioned store (control)', async () => {
    await expect(new PipelineStartupCheck(switchFor('enabled'), new InMemoryObjectStorage()).onApplicationBootstrap()).resolves.toBeUndefined();
  });
});

@Controller('gated')
@RequiresPipeline()
class GatedController {
  static calls = 0;
  @Get()
  work() {
    GatedController.calls++;
    return { ok: true };
  }
}

describe('PipelineGateGuard on a route marked RequiresPipeline', () => {
  const boot = async (state: 'enabled' | 'disabled'): Promise<INestApplication> => {
    const moduleRef = await Test.createTestingModule({
      controllers: [GatedController],
      providers: [
        { provide: PipelineSwitch, useValue: switchFor(state) },
        PipelineGateGuard,
        { provide: PinoLogger, useValue: { setContext: () => undefined, warn: () => undefined, error: () => undefined } },
      ],
    }).compile();
    const app = moduleRef.createNestApplication();
    app.useGlobalFilters(new AllExceptionsFilter(moduleRef.get(PinoLogger)));
    await app.init();
    return app;
  };

  it('answers 503 PIPELINE_DISABLED without running the handler while off', async () => {
    const app = await boot('disabled');
    GatedController.calls = 0;
    const res = await request(app.getHttpServer()).get('/gated').expect(503);
    expect(res.body.error.code).toBe('PIPELINE_DISABLED');
    expect(res.headers['retry-after']).toBeUndefined();
    expect(GatedController.calls).toBe(0);
    await app.close();
  });

  it('runs the handler while on (control)', async () => {
    const app = await boot('enabled');
    GatedController.calls = 0;
    await request(app.getHttpServer()).get('/gated').expect(200);
    expect(GatedController.calls).toBe(1);
    await app.close();
  });

  it('marks the controller so a test can find every pipeline route', () => {
    expect(Reflect.getMetadata(REQUIRES_PIPELINE, GatedController)).toBe(true);
  });
});

@Controller('faults')
class FaultController {
  @Get('busy') busy() { throw AppException.pipelineBusy(); }
  @Get('reader') reader() { throw AppException.readerUnavailable(); }
  @Get('ledger') ledger() { throw AppException.ledgerBusy(); }
  @Get('misconfigured') misconfigured() { throw AppException.pipelineMisconfigured(); }
}

describe('the Retry-After header', () => {
  it('is sent for the three "try again" errors and for no other', async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [FaultController],
      providers: [{ provide: PinoLogger, useValue: { setContext: () => undefined, warn: () => undefined, error: () => undefined } }],
    }).compile();
    const app = moduleRef.createNestApplication();
    app.useGlobalFilters(new AllExceptionsFilter(moduleRef.get(PinoLogger)));
    await app.init();
    const get = (path: string) => request(app.getHttpServer()).get(`/faults/${path}`);
    expect((await get('busy').expect(503)).headers['retry-after']).toBe('5');
    expect((await get('reader').expect(503)).headers['retry-after']).toBe('30');
    expect((await get('ledger').expect(503)).headers['retry-after']).toBe('2');
    const misconfigured = await get('misconfigured').expect(500);
    expect(misconfigured.headers['retry-after']).toBeUndefined();
    expect(misconfigured.body.error.code).toBe('PIPELINE_MISCONFIGURED');
    await app.close();
  });
});
