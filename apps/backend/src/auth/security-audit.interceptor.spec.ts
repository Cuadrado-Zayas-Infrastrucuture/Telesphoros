import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { lastValueFrom, of } from 'rxjs';
import { IS_PUBLIC_KEY } from './decorators';
import type { SecurityAuditStore } from './security-audit';
import { InMemorySecurityAuditStore, type SecurityAuditEvent } from './security-audit';
import { SecurityAuditInterceptor } from './security-audit.interceptor';

class PatientsController {
  create() {
    return undefined;
  }
  replace() {
    return undefined;
  }
  list() {
    return undefined;
  }
}

const SUBJECT = '2e40eac9-bc8e-4d41-a319-c70775c941aa';

function context(method: string, options: { params?: Record<string, string>; principal?: boolean; handler?: () => unknown; public?: boolean } = {}): ExecutionContext {
  const handler = options.handler ?? PatientsController.prototype.create;
  if (options.public) Reflect.defineMetadata(IS_PUBLIC_KEY, true, handler);
  const req = { method, id: 'synthetic-request-0001', params: options.params ?? {}, principal: options.principal === false ? undefined : { tenantId: 'tenant-a', sub: 'user-a' } };
  return { switchToHttp: () => ({ getRequest: () => req }), getClass: () => PatientsController, getHandler: () => handler } as unknown as ExecutionContext;
}

function setup(store: SecurityAuditStore = new InMemorySecurityAuditStore()) {
  const order: string[] = [];
  const handler: CallHandler = {
    handle: () => {
      order.push('handler');
      return of('done');
    },
  };
  const recording = new Proxy(store, {
    get: (t, p, r) =>
      p === 'record'
        ? async (e: SecurityAuditEvent) => {
            order.push(`audit:${e.type}:${e.outcome}`);
            return t.record(e);
          }
        : Reflect.get(t, p, r),
  });
  return { interceptor: new SecurityAuditInterceptor(new Reflector(), recording), handler, order, store };
}

describe('the audit interceptor on a write', () => {
  it.each(['POST', 'PUT', 'PATCH', 'DELETE'])('%s records a private-write event BEFORE the handler runs, with the route and the path id and nothing else', async (method) => {
    const { interceptor, handler, order, store } = setup();
    await lastValueFrom(interceptor.intercept(context(method, { params: { id: SUBJECT } }), handler));
    expect(order).toEqual(['audit:private-write:accepted', 'handler']);
    expect((store as InMemorySecurityAuditStore).events).toEqual([
      {
        type: 'private-write',
        outcome: 'accepted',
        tenantId: 'tenant-a',
        actorSub: 'user-a',
        routeKey: 'PatientsController.create',
        subjectId: SUBJECT,
        requestId: 'synthetic-request-0001',
      },
    ]);
  });

  it('has no subject when the path carries no id, and drops an id that is not a UUID', async () => {
    const a = setup();
    await lastValueFrom(a.interceptor.intercept(context('POST'), a.handler));
    expect((a.store as InMemorySecurityAuditStore).events[0]!.subjectId).toBeNull();
    const b = setup();
    await lastValueFrom(b.interceptor.intercept(context('PUT', { params: { id: 'not a uuid; DROP TABLE' } }), b.handler));
    expect((b.store as InMemorySecurityAuditStore).events[0]!.subjectId).toBeNull();
  });

  it('does not run the handler when the audit row cannot be written (a write must not happen unrecorded)', async () => {
    const failing: SecurityAuditStore = {
      record: async () => {
        throw new Error('audit unavailable');
      },
    };
    const { interceptor, handler, order } = setup(failing);
    await expect(lastValueFrom(interceptor.intercept(context('POST'), handler))).rejects.toThrow('audit unavailable');
    expect(order).not.toContain('handler');
  });

  it('records nothing for a public route, an unauthenticated request, or a method that changes nothing', async () => {
    for (const [method, options] of [
      ['POST', { public: true }],
      ['POST', { principal: false }],
      ['HEAD', {}],
      ['OPTIONS', {}],
    ] as const) {
      const { interceptor, handler, store } = setup();
      await lastValueFrom(interceptor.intercept(context(method, options), handler));
      expect({ method, options, events: (store as InMemorySecurityAuditStore).events }).toEqual({ method, options, events: [] });
    }
  });

  it('leaves a read as it was: the event is written after the handler, as private-read (control)', async () => {
    const { interceptor, handler, order, store } = setup();
    await lastValueFrom(interceptor.intercept(context('GET', { handler: PatientsController.prototype.list }), handler));
    expect(order).toEqual(['handler', 'audit:private-read:succeeded']);
    expect((store as InMemorySecurityAuditStore).events[0]).toMatchObject({ type: 'private-read', routeKey: 'PatientsController.list' });
  });
});

// Spec 046 AR-2: the evaluations list names its patient in the query, so its read row takes that patient as its subject. Nothing else changes.
describe('the audit interceptor on the evaluations list', () => {
  class EvaluationsController {
    list() {
      return undefined;
    }
    get() {
      return undefined;
    }
  }
  class FollowupsController {
    read() {
      return undefined;
    }
  }
  const readContext = (cls: new () => object, handler: () => unknown, params: Record<string, string>, query: Record<string, unknown>): ExecutionContext => {
    const req = { method: 'GET', id: 'synthetic-request-0002', params, query, principal: { tenantId: 'tenant-a', sub: 'user-a' } };
    return { switchToHttp: () => ({ getRequest: () => req }), getClass: () => cls, getHandler: () => handler } as unknown as ExecutionContext;
  };
  const subjectOf = async (cls: new () => object, handler: () => unknown, params: Record<string, string>, query: Record<string, unknown>) => {
    const { interceptor, handler: next, store } = setup();
    await lastValueFrom(interceptor.intercept(readContext(cls, handler, params, query), next));
    return (store as InMemorySecurityAuditStore).events[0]!.subjectId;
  };

  it('records the patientId of the query as the subject of the list', async () => {
    expect(await subjectOf(EvaluationsController, EvaluationsController.prototype.list, {}, { patientId: SUBJECT, page: '1' })).toBe(SUBJECT);
  });

  it('drops a patientId that is not one UUID, and records none when the list names no patient', async () => {
    expect(await subjectOf(EvaluationsController, EvaluationsController.prototype.list, {}, { patientId: 'x; DROP TABLE' })).toBeNull();
    expect(await subjectOf(EvaluationsController, EvaluationsController.prototype.list, {}, { patientId: [SUBJECT, SUBJECT] })).toBeNull();
    expect(await subjectOf(EvaluationsController, EvaluationsController.prototype.list, {}, {})).toBeNull();
  });

  it('leaves every other route as it was: the path id, or none, whatever the query holds (controls)', async () => {
    const other = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
    expect(await subjectOf(EvaluationsController, EvaluationsController.prototype.get, { id: other }, { patientId: SUBJECT })).toBe(other);
    expect(await subjectOf(FollowupsController, FollowupsController.prototype.read, {}, { patientId: SUBJECT })).toBeNull();
  });
});
