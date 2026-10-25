import { MeController } from './me.controller';
import type { Principal } from '../auth/principal';
import type { MemberAdminRepository } from '../storage/member-admin.repository';
import { recoveryScopeDtoSchema } from '@telesphoros/shared-types';

const principal: Principal = { sub: 'synthetic-user-a', tenantId: 'synthetic-alpha', roles: ['clinician'] };
const unusedMembers = {} as MemberAdminRepository;
describe('the verified principal recovery binding', () => {
  const me = new MeController(unusedMembers);
  it('is stable across role changes and exposes only permissions and an opaque binding', () => {
    const first = me.recoveryScope(principal);
    expect(recoveryScopeDtoSchema.safeParse(first).success).toBe(true);
    expect(first.recoveryScope).toMatch(/^[0-9a-f]{64}$/);
    expect(Object.keys(first).sort()).toEqual(['recoveryScope']);
    expect(first.recoveryScope).not.toContain(principal.sub);
    expect(first.recoveryScope).not.toContain(principal.tenantId);
    expect(me.recoveryScope({ ...principal, roles: [] }).recoveryScope).toBe(first.recoveryScope);
  });
  it('separates both people in one organization and the same subject in a different organization', () => {
    const first = me.recoveryScope(principal).recoveryScope;
    expect(me.recoveryScope({ ...principal, sub: 'synthetic-user-b' }).recoveryScope).not.toBe(first);
    expect(me.recoveryScope({ ...principal, tenantId: 'synthetic-beta' }).recoveryScope).not.toBe(first);
  });
});

it('preserves the roles-only response that old clients strictly parse', () => {
  const me = new MeController(unusedMembers);
  expect(me.me(principal)).toEqual({ roles: ['clinician'] });
  expect(me.me({ ...principal, roles: [] })).toEqual({ roles: [] });
});

it("sign-out ends only the caller's own sessions, passing the verified principal and nothing from the request", async () => {
  const signOut = jest.fn(async () => undefined);
  const me = new MeController({ signOut } as unknown as MemberAdminRepository);
  await expect(me.signOut(principal)).resolves.toBeUndefined();
  expect(signOut).toHaveBeenCalledWith(principal);
});
