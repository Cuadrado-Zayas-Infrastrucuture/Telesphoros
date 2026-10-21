import type { Request, Response } from 'express';
import {
  asOrganizationWork, authorityContextMiddleware, bindRequestAuthority, bindRequestCapability, currentRequestAuthority, currentRequestCapability,
  currentRequestId, duringAdmission, isAdmitting, noteCapabilityAbsent, capabilityAbsentReason,
} from './authority-context';

/**
 * DATA-01 T017: the request's capability lives in the request's AsyncLocalStorage slot beside its authority. `asOrganizationWork` keeps the capability
 * while dropping the authority (a removed person's request must not abort cleanup, and a fresh issuance for them would be refused).
 */
const TOKEN = 'A'.repeat(43);
const inRequest = <T>(work: () => T): T => {
  let result!: T;
  authorityContextMiddleware({ id: 'req-ctx-0001' } as unknown as Request, {} as Response, () => {
    result = work();
  });
  return result;
};
const capability = () => ({ token: TOKEN, expiresAt: new Date('2030-01-01T00:00:00Z') });

describe('the request capability slot', () => {
  it('holds the capability beside the authority', () => {
    inRequest(() => {
      expect(currentRequestCapability()).toBeUndefined();
      bindRequestAuthority({ sub: 'alice', version: 3 });
      bindRequestCapability(capability());
      expect(currentRequestCapability()).toEqual(capability());
      expect(currentRequestAuthority()).toEqual({ sub: 'alice', version: 3 });
    });
  });

  it('is empty outside any request, and refuses to be bound there', () => {
    expect(currentRequestCapability()).toBeUndefined();
    expect(() => bindRequestCapability(capability())).toThrow(/authorityContextMiddleware/);
  });

  it('does not leak between requests', () => {
    inRequest(() => bindRequestCapability(capability()));
    inRequest(() => expect(currentRequestCapability()).toBeUndefined());
  });

  it('keeps its own copy: changing the object it was given changes nothing', () => {
    inRequest(() => {
      const given = capability();
      bindRequestCapability(given);
      given.token = 'B'.repeat(43);
      expect(currentRequestCapability()!.token).toBe(TOKEN);
      expect(Object.isFrozen(currentRequestCapability())).toBe(true);
    });
  });

  it.each(['', 'short', 'A'.repeat(42), 'A'.repeat(44), `${'A'.repeat(42)}=`, `${'A'.repeat(42)} `, `${'A'.repeat(42)}'`])('refuses a token that is not 43 URL-safe characters: %j', (token) => {
    inRequest(() => {
      expect(() => bindRequestCapability({ token, expiresAt: new Date() })).toThrow(/capability/i);
      expect(currentRequestCapability()).toBeUndefined();
    });
  });

  it('binds once: a second binding in the same request is refused, so a request cannot swap its proof', () => {
    inRequest(() => {
      bindRequestCapability(capability());
      expect(() => bindRequestCapability({ token: 'B'.repeat(43), expiresAt: new Date() })).toThrow(/already/i);
      expect(currentRequestCapability()!.token).toBe(TOKEN);
    });
  });
});

describe('asOrganizationWork', () => {
  it('keeps the capability and drops the authority', () => {
    inRequest(() => {
      bindRequestAuthority({ sub: 'alice', version: 3 });
      bindRequestCapability(capability());
      expect(asOrganizationWork(currentRequestAuthority)).toBeUndefined();
      expect(asOrganizationWork(currentRequestCapability)).toEqual(capability());
      expect(currentRequestAuthority()).toBeDefined(); // the request itself is untouched
    });
  });

  it('keeps it across an await inside the organization work', async () => {
    await inRequest(async () => {
      bindRequestCapability(capability());
      const seen = await asOrganizationWork(async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return currentRequestCapability();
      });
      expect(seen).toEqual(capability());
    });
  });

  it('with no capability it is what it was: a context with nothing in it', () => {
    inRequest(() => {
      bindRequestAuthority({ sub: 'alice', version: 3 });
      expect(asOrganizationWork(currentRequestCapability)).toBeUndefined();
      expect(asOrganizationWork(currentRequestId)).toBeUndefined();
    });
  });

  it('outside a request it runs the work and has no capability', () => {
    expect(asOrganizationWork(() => currentRequestCapability())).toBeUndefined();
  });
});

describe('admission and the absent-capability reason', () => {
  it('marks the guard\'s own lookup, and only while it runs', async () => {
    await inRequest(async () => {
      expect(isAdmitting()).toBe(false);
      await duringAdmission(async () => {
        expect(isAdmitting()).toBe(true);
      });
      expect(isAdmitting()).toBe(false);
      await duringAdmission(async () => { throw new Error('x'); }).catch(() => undefined);
      expect(isAdmitting()).toBe(false); // cleared even when the lookup throws
    });
  });

  it('records why a request has no capability, once the guard has tried', () => {
    inRequest(() => {
      expect(capabilityAbsentReason()).toBeUndefined();
      noteCapabilityAbsent('not-configured');
      expect(capabilityAbsentReason()).toBe('not-configured');
    });
  });
});
