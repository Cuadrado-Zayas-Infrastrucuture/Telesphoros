import type { Request, Response } from 'express';
import type { PoolClient } from 'pg';
import { authorityContextMiddleware, bindRequestAuthority, currentRequestAuthority, asOrganizationWork, type RequestAuthority } from './authority-context';
import { assertSessionAuthority, assertSessionCurrent, type BrowserSessionAuthority } from './session-admission';

const binding = (): BrowserSessionAuthority => ({ tenantId: 'tenant-admission', handleHash: 'a'.repeat(64), issuedAt: 1_000,
  createdAt: 1_000_000, expiresAt: 1_060_000 });

it('accepts well-formed immutable metadata without interpreting local time as database admission', () => {
  expect(() => assertSessionAuthority(binding())).not.toThrow();
});

it.each([
  null, undefined, false, '', {},
  { ...binding(), tenantId: 'Bad tenant' }, { ...binding(), handleHash: 'A'.repeat(64) },
  { ...binding(), issuedAt: -1 }, { ...binding(), issuedAt: 1.5 },
  { ...binding(), createdAt: NaN }, { ...binding(), expiresAt: Infinity },
  { ...binding(), createdAt: Number.MAX_SAFE_INTEGER },
  { ...binding(), expiresAt: binding().createdAt },
  { ...binding(), expiresAt: binding().createdAt + 900_001 },
])('refuses malformed session binding %#', value => {
  expect(() => assertSessionAuthority(value)).toThrow(expect.objectContaining({ status: 401 }));
});

it('a present undefined session binding cannot fall back to bearer authority', () => {
  authorityContextMiddleware({} as Request, {} as Response, () => {
    expect(() => bindRequestAuthority({ sub: 'person', version: 1, session: undefined })).toThrow(expect.objectContaining({ status: 401 }));
    expect(currentRequestAuthority()).toBeUndefined();
  });
});

it('owns and freezes only the non-secret metadata, including when the input changes later', () => {
  const source = { sub: 'person', version: 1, session: { ...binding(), accessToken: 'synthetic-not-for-context' } };
  authorityContextMiddleware({} as Request, {} as Response, () => {
    bindRequestAuthority(source);
    source.sub = 'different-person'; source.version = 2; source.session.handleHash = 'b'.repeat(64);
    expect(currentRequestAuthority()).toEqual({ sub: 'person', version: 1, session: binding() });
    expect(Object.isFrozen(currentRequestAuthority())).toBe(true);
    expect(Object.isFrozen(currentRequestAuthority()!.session)).toBe(true);
    expect('accessToken' in currentRequestAuthority()!.session!).toBe(false);
  });
  expect(currentRequestAuthority()).toBeUndefined();
});

it('an inherited session binding is checked and owned, never silently discarded', () => {
  const source = Object.assign(Object.create({ session: binding() }) as RequestAuthority, { sub: 'person', version: 1 });
  authorityContextMiddleware({} as Request, {} as Response, () => {
    bindRequestAuthority(source);
    expect(Object.hasOwn(currentRequestAuthority()!, 'session')).toBe(true);
    expect(currentRequestAuthority()!.session).toEqual(binding());
  });
});

it('preserves bearer authority and confines organization work to its own callback', () => {
  authorityContextMiddleware({} as Request, {} as Response, () => {
    bindRequestAuthority({ sub: 'person', version: 1 });
    expect(currentRequestAuthority()).toEqual({ sub: 'person', version: 1 });
    expect(asOrganizationWork(currentRequestAuthority)).toBeUndefined();
    expect(currentRequestAuthority()).toEqual({ sub: 'person', version: 1 });
  });
});

it('keeps parallel asynchronous request bindings isolated', async () => {
  const request = (sub: string, handleHash: string) => new Promise<void>((resolve, reject) => {
    authorityContextMiddleware({} as Request, {} as Response, () => {
      bindRequestAuthority({ sub, version: 1, session: { ...binding(), handleHash } });
      Promise.resolve().then(() => {
        expect(currentRequestAuthority()!.sub).toBe(sub);
        expect(currentRequestAuthority()!.session!.handleHash).toBe(handleHash);
      }).then(resolve, reject);
    });
  });
  await Promise.all([request('person-a', 'a'.repeat(64)), request('person-b', 'b'.repeat(64))]);
});

it('does not bind any authority outside the registered request slot', () => {
  expect(() => bindRequestAuthority({ sub: 'person', version: 1, session: binding() })).toThrow(/authorityContextMiddleware/);
});

it('refuses foreign transaction scope without issuing a query', async () => {
  const query = jest.fn();
  await expect(assertSessionCurrent({ query } as unknown as PoolClient, 'foreign-tenant', 'person', binding())).rejects.toMatchObject({ status: 401 });
  expect(query).not.toHaveBeenCalled();
});

it.each(['57P01', '40P01', '55P03'])('sanitizes authority query failure %s as unavailable rather than unauthorized', async code => {
  const query = jest.fn().mockRejectedValue(Object.assign(new Error('synthetic detail must not escape'), { code }));
  await expect(assertSessionCurrent({ query } as unknown as PoolClient, 'tenant-admission', 'person', binding()))
    .rejects.toMatchObject({ status: 503, message: 'Access checks are unavailable.' });
});
