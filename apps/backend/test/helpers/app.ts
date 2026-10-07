import { Controller, Get, type Type } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/app.factory';
import { Public } from '../../src/auth/decorators';
import { READINESS_CHECKS, type ReadinessCheck } from '../../src/health/readiness.service';
import { testEnv } from './env';

export interface TestAppOptions {
  controllers?: Type<unknown>[];
  readinessChecks?: ReadinessCheck[];
}

/** Boots the REAL module graph with the REAL app configuration (prefix, versioning, filters, guards). */
export async function createTestApp(options: TestAppOptions = {}): Promise<NestExpressApplication> {
  let builder = Test.createTestingModule({
    imports: [AppModule.register(testEnv)],
    controllers: options.controllers ?? [],
  });
  if (options.readinessChecks) builder = builder.overrideProvider(READINESS_CHECKS).useValue(options.readinessChecks);
  const moduleRef = await builder.compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>();
  configureApp(app);
  // Listen once on a free port. Otherwise supertest starts/stops the server per request, and two
  // requests built in the same expression race for it.
  await app.listen(0);
  return app;
}

/** Test-only routes that misbehave on purpose, to prove nothing internal leaks. */
@Controller('test-faults')
export class FaultsController {
  @Public()
  @Get('crash')
  crash() {
    throw new Error('db password=hunter2 at /srv/app/secret-file.ts:42');
  }

  @Public()
  @Get('type-error')
  typeError() {
    return (undefined as unknown as { x: { y: string } }).x.y;
  }
}
