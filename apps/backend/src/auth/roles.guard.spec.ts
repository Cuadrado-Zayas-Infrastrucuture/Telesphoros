import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ROLES_KEY } from './decorators';
import { RolesGuard } from './roles.guard';
import { InMemorySecurityAuditStore } from './security-audit';

class PatientsController {
  remove() {
    return undefined;
  }
}

const SUBJECT = '2e40eac9-bc8e-4d41-a319-c70775c941aa';
Reflect.defineMetadata(ROLES_KEY, ['clinician'], PatientsController.prototype.remove);

function context(method: string, roles: string[]): ExecutionContext {
  const req = { method, id: 'synthetic-request-0001', params: { id: SUBJECT }, principal: { tenantId: 'tenant-a', sub: 'user-a', roles } };
  return {
    switchToHttp: () => ({ getRequest: () => req }),
    getClass: () => PatientsController,
    getHandler: () => PatientsController.prototype.remove,
  } as unknown as ExecutionContext;
}

function setup() {
  const store = new InMemorySecurityAuditStore();
  return { guard: new RolesGuard(new Reflector(), store), store };
}

describe('RolesGuard refusals', () => {
  it.each(['POST', 'PUT', 'PATCH', 'DELETE'])('%s refused for its role records a private-write refusal with the route and the path id', async (method) => {
    const { guard, store } = setup();
    await expect(guard.canActivate(context(method, ['reader']))).rejects.toMatchObject({ status: 403 });
    expect(store.events).toEqual([
      {
        type: 'private-write',
        outcome: 'refused',
        tenantId: 'tenant-a',
        actorSub: 'user-a',
        routeKey: 'PatientsController.remove',
        subjectId: SUBJECT,
        requestId: 'synthetic-request-0001',
      },
    ]);
  });

  it('GET refused for its role records a private-read refusal, as before', async () => {
    const { guard, store } = setup();
    await expect(guard.canActivate(context('GET', ['reader']))).rejects.toMatchObject({ status: 403 });
    expect(store.events.map((e) => [e.type, e.outcome])).toEqual([['private-read', 'refused']]);
  });

  it.each(['HEAD', 'OPTIONS'])('%s refused records nothing', async (method) => {
    const { guard, store } = setup();
    await expect(guard.canActivate(context(method, ['reader']))).rejects.toMatchObject({ status: 403 });
    expect(store.events).toEqual([]);
  });

  it('a write allowed for its role records nothing here (the interceptor records it)', async () => {
    const { guard, store } = setup();
    await expect(guard.canActivate(context('DELETE', ['clinician']))).resolves.toBe(true);
    expect(store.events).toEqual([]);
  });
});
