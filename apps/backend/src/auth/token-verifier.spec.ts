import { TEST_AUDIENCE, TEST_ISSUER, TEST_SECRET } from '../../test/helpers/env';
import { signToken } from '../../test/helpers/tokens';
import { HmacTokenVerifier, InvalidTokenError, NoTenantError } from './token-verifier';

const verifier = new HmacTokenVerifier({ JWT_SECRET: TEST_SECRET, JWT_ISSUER: TEST_ISSUER, JWT_AUDIENCE: TEST_AUDIENCE });

describe('HmacTokenVerifier', () => {
  it('returns the subject, tenant and roles from a valid token', async () => {
    await expect(verifier.verify(await signToken({ sub: 'u1', tenant: 'acme', roles: ['clinician', 'admin'] }))).resolves.toMatchObject({
      sub: 'u1',
      tenantId: 'acme',
      roles: ['clinician', 'admin'],
    });
  });

  it('reports when the token was issued, in seconds (the membership revocation instant is compared with it)', async () => {
    const before = Math.floor(Date.now() / 1000);
    const identity = await verifier.verify(await signToken({ sub: 'u1', tenant: 'acme', iat: -30 }));
    expect(identity.issuedAt).toBeGreaterThanOrEqual(before - 31);
    expect(identity.issuedAt).toBeLessThanOrEqual(before - 29);
  });

  it('keeps every role the token carries, reviewer included, in any combination', async () => {
    for (const roles of [['reviewer'], ['clinician', 'reviewer'], ['admin', 'reviewer'], ['reader', 'clinician', 'admin', 'reviewer']] as const) {
      await expect(verifier.verify(await signToken({ sub: 'u1', tenant: 'acme', roles: [...roles] }))).resolves.toMatchObject({ sub: 'u1', tenantId: 'acme', roles: [...roles] });
    }
  });

  it('treats a missing roles claim as NO roles (least privilege)', async () => {
    await expect(verifier.verify(await signToken({ sub: 'u1', tenant: 'acme' }))).resolves.toMatchObject({ sub: 'u1', tenantId: 'acme', roles: [] });
  });

  it.each([
    ['missing', null],
    ['empty', ''],
    ['upper case', 'Acme'],
    ['with a space', 'a b'],
    ['64 characters', 'a'.repeat(64)],
    ['not a string', 7 as unknown as string],
  ])('refuses a genuine token whose tenant claim is %s', async (_name, tenant) => {
    await expect(verifier.verify(await signToken({ sub: 'u1', tenant }))).rejects.toBeInstanceOf(NoTenantError);
  });

  it('a forged token without a tenant is just "Invalid token" (it learns nothing about tenants)', async () => {
    const error = await verifier.verify(await signToken({ tenant: null, secret: 'another-secret-another-secret-another-1234' })).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(InvalidTokenError);
    expect(error).not.toBeInstanceOf(NoTenantError);
  });

  it.each([
    ['wrong secret', () => signToken({ secret: 'another-secret-another-secret-another-1234' })],
    ['expired', () => signToken({ iat: -7200, exp: -60 })],
    ['too old', () => signToken({ iat: -4000, exp: 600 })],
    ['wrong issuer', () => signToken({ issuer: 'x' })],
    ['wrong audience', () => signToken({ audience: 'x' })],
    ['no subject', () => signToken({ sub: null })],
    ['oversize subject', () => signToken({ sub: 's'.repeat(129) })],
    ['bad role', () => signToken({ roles: ['root'] })],
  ])('rejects a token that is %s with one generic error', async (_name, make) => {
    const error = await verifier.verify(await make()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(InvalidTokenError);
    expect((error as Error).message).toBe('Invalid token');
  });

  it('refuses a token whose subject is a system actor: no person can hold the name a background job acts under', async () => {
    for (const sub of ['system:uploads.sweep', 'system:', 'system:scheduler']) {
      const error = await verifier.verify(await signToken({ sub, tenant: 'acme', roles: ['admin'] })).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(InvalidTokenError);
      expect((error as Error).message).toBe('Invalid token');
    }
    // Only the exact prefix is reserved.
    for (const sub of ['systemic', 'a:system:b', 'System:x', 'sys']) await expect(verifier.verify(await signToken({ sub, tenant: 'acme' }))).resolves.toMatchObject({ sub });
  });

  it('rejects non-JWT input', async () => {
    await expect(verifier.verify('')).rejects.toBeInstanceOf(InvalidTokenError);
    await expect(verifier.verify('abc')).rejects.toBeInstanceOf(InvalidTokenError);
  });
});
