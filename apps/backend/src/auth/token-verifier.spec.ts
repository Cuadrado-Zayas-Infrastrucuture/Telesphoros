import { TEST_AUDIENCE, TEST_ISSUER, TEST_SECRET } from '../../test/helpers/env';
import { signToken } from '../../test/helpers/tokens';
import { HmacTokenVerifier, InvalidTokenError } from './token-verifier';

const verifier = new HmacTokenVerifier({ JWT_SECRET: TEST_SECRET, JWT_ISSUER: TEST_ISSUER, JWT_AUDIENCE: TEST_AUDIENCE });

describe('HmacTokenVerifier', () => {
  it('returns the subject and roles from a valid token', async () => {
    await expect(verifier.verify(await signToken({ sub: 'u1', roles: ['clinician', 'admin'] }))).resolves.toEqual({
      sub: 'u1',
      roles: ['clinician', 'admin'],
    });
  });

  it('treats a missing roles claim as NO roles (least privilege)', async () => {
    await expect(verifier.verify(await signToken({ sub: 'u1' }))).resolves.toEqual({ sub: 'u1', roles: [] });
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

  it('rejects non-JWT input', async () => {
    await expect(verifier.verify('')).rejects.toBeInstanceOf(InvalidTokenError);
    await expect(verifier.verify('abc')).rejects.toBeInstanceOf(InvalidTokenError);
  });
});
