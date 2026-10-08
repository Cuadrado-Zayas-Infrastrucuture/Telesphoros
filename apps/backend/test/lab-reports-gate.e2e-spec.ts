import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { ROLES_KEY } from '../src/auth/decorators';
import { CapturesController, ReportCaptureController } from '../src/lab-reports/captures.controller';
import { LabReportsModule } from '../src/lab-reports/lab-reports.module';
import { REQUIRES_PIPELINE } from '../src/lab-reports/pipeline-switch';
import { TextCaptureRunner } from '../src/lab-reports/runner/text-capture-runner';
import { ObjectStorage } from '../src/object-storage/object-storage';
import { LedgerRecordsRepository } from '../src/storage/ledger-records.repository';
import { createTestApp } from './helpers/app';
import { bearer, signToken } from './helpers/tokens';

// With the pipeline switched off (the default), every pipeline route answers 503 PIPELINE_DISABLED to someone allowed to use it, and does
// NOTHING: no storage read, write or link, no ledger access, no reader. Who may not use the route still hears 401 or 403, never 503.
// The routes are taken from the controllers' own metadata, so a route added later without the gate cannot be forgotten.
const ID = '00000000-0000-4000-8000-000000000001';
type ControllerClass = (new (...args: never[]) => object) & { prototype: Record<string, unknown> };

interface Route {
  controller: ControllerClass;
  method: string;
  path: string;
  roles: string[] | undefined;
  handler: string;
}

function routesOf(controller: ControllerClass): Route[] {
  const base = Reflect.getMetadata(PATH_METADATA, controller) as string;
  return Object.getOwnPropertyNames(controller.prototype)
    .filter((name) => name !== 'constructor' && Reflect.getMetadata(METHOD_METADATA, controller.prototype[name] as object) !== undefined)
    .map((name) => ({
      controller,
      handler: name,
      method: RequestMethod[Reflect.getMetadata(METHOD_METADATA, controller.prototype[name] as object) as number]!,
      path: `/api/v1/${base}/${Reflect.getMetadata(PATH_METADATA, controller.prototype[name] as object) as string}`.replace(':id', ID),
      roles: Reflect.getMetadata(ROLES_KEY, controller.prototype[name] as object) as string[] | undefined,
    }));
}

const moduleControllers = Reflect.getMetadata('controllers', LabReportsModule) as ControllerClass[];
const routes = moduleControllers.flatMap(routesOf);

describe('the lab-report pipeline routes', () => {
  it('are exactly the routes this slice defines (a hand-written list, so an enumeration that finds nothing cannot pass)', () => {
    expect(routes.map((r) => `${r.method} ${r.path.replace(ID, ':id')}`).sort()).toEqual([
      'GET /api/v1/captures/:id',
      'GET /api/v1/captures/:id/text-url',
      'GET /api/v1/reports/:id/download-url',
      'POST /api/v1/captures/:id/decision',
      'POST /api/v1/reports/:id/capture',
    ]);
    expect(moduleControllers).toEqual(expect.arrayContaining([ReportCaptureController, CapturesController]));
  });

  it('every controller of the module carries the gate, and every route that is not open to all names its roles', () => {
    for (const controller of moduleControllers) expect(Reflect.getMetadata(REQUIRES_PIPELINE, controller)).toBe(true);
    const open = routes.filter((r) => r.roles === undefined).map((r) => `${r.method} ${r.path.replace(ID, ':id')}`);
    expect(open).toEqual(['GET /api/v1/captures/:id']); // the one read open to every signed-in role
  });
});

describe('with the pipeline switched off', () => {
  let app: NestExpressApplication;
  const calls: string[] = [];

  beforeAll(async () => {
    app = await createTestApp();
    const spy = (target: object, label: string) => {
      for (const name of Object.getOwnPropertyNames(Object.getPrototypeOf(target)).filter((n) => n !== 'constructor')) {
        const original = (target as Record<string, (...args: unknown[]) => unknown>)[name]!.bind(target);
        (target as Record<string, unknown>)[name] = (...args: unknown[]) => {
          calls.push(`${label}.${name}`);
          return original(...args);
        };
      }
    };
    spy(app.get(ObjectStorage), 'storage');
    try {
      spy(app.get(LedgerRecordsRepository, { strict: false }), 'ledger'); // registered only with PostgreSQL
    } catch {
      // intentional: with the in-memory store there is no ledger repository at all, so there is nothing to spy on
    }
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(() => {
    calls.length = 0;
  });

  const send = (route: Route, token?: string) => {
    const call = request(app.getHttpServer())[route.method.toLowerCase() as 'get' | 'post'](route.path);
    const withAuth = token ? call.set(bearer(token)) : call;
    return route.method === 'POST' ? withAuth.send(route.path.endsWith('/decision') ? { decision: 'accepted' } : {}) : withAuth;
  };
  const tokenWith = (roles: string[]) => signToken({ sub: 'someone', roles, tenant: 'tenant-gate' });

  it.each(routes.map((r) => [`${r.method} ${r.path.replace(ID, ':id')}`, r] as const))('%s: 503 PIPELINE_DISABLED for someone allowed, nothing touched', async (_name, route) => {
    const allowed = await tokenWith(route.roles ?? ['reader']);
    const res = await send(route, allowed);
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('PIPELINE_DISABLED');
    expect(res.headers['retry-after']).toBeUndefined();
    expect(calls).toEqual([]);
  });

  it.each(routes.map((r) => [`${r.method} ${r.path.replace(ID, ':id')}`, r] as const))('%s: 401 without a token and 403 without the role, never 503', async (_name, route) => {
    expect((await send(route)).status).toBe(401);
    if (route.roles) {
      const wrong = ['reader', 'clinician', 'reviewer', 'admin'].find((role) => !route.roles!.includes(role))!;
      const res = await send(route, await tokenWith([wrong]));
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
    }
    expect(calls).toEqual([]);
  });

  it('answers 503 before it looks at the request: a malformed id or body from an allowed caller is still 503, not 400', async () => {
    const reviewer = await tokenWith(['reviewer']);
    const res = await request(app.getHttpServer()).post('/api/v1/captures/not-a-uuid/decision').set(bearer(reviewer)).send({ decision: 'nonsense' });
    expect(res.status).toBe(503);
    expect(calls).toEqual([]);
  });

  it('builds neither the text runner nor any ledger access while off', () => {
    expect(app.get(TextCaptureRunner, { strict: false })).toBeUndefined();
  });
});
