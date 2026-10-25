import { randomBytes } from 'node:crypto';
import { BrowserSessionCustody } from './browser-session';
import { SessionCrypto } from './session-crypto';
import { BrowserSessionRepository, type BrowserSessionRecord, SessionCustodyError } from '../storage/browser-session.repository';

const NOW = 1_800_000_000_000;
class FixtureRepository extends BrowserSessionRepository {
  rows = new Map<string, BrowserSessionRecord>();
  insert = jest.fn(async (row: BrowserSessionRecord) => {
    this.rows.set(row.tenantId + row.handleHash, row);
  });
  findActive = jest.fn(async (tenant: string, hash: string) => this.rows.get(tenant + hash));
  revoke = jest.fn(async (tenant: string, hash: string) => this.rows.delete(tenant + hash));
  cleanupExpired = jest.fn(async () => 0);
}
const fixture = () => {
  const repository = new FixtureRepository();
  const crypto = new SessionCrypto('test', new Map([['test', randomBytes(32)]]));
  const clock = { now: NOW };
  const custody = new BrowserSessionCustody(repository, crypto, () => clock.now);
  return { repository, crypto, custody, clock };
};
const input = () => ({
  identity: { tenantId: 'tenant-a', sub: 'person-a', issuedAt: NOW / 1000 - 10, roles: ['reader' as const] },
  accessToken: 'synthetic-token',
  tokenExpiresAt: new Date(NOW + 3_600_000),
});

it('stores only a handle digest and sealed credential; a second instance can recover the same custody', async () => {
  const { repository, crypto, custody } = fixture();
  const made = await custody.create(input());
  const row = [...repository.rows.values()][0]!;
  expect(made.expiresAt.getTime()).toBe(NOW + 15 * 60 * 1000);
  expect(JSON.stringify(row)).not.toContain('synthetic-token');
  expect(row).not.toHaveProperty('roles');
  expect(row).not.toHaveProperty('handle');
  const second = new BrowserSessionCustody(repository, crypto, () => NOW);
  expect(await second.read(made.cookie)).toMatchObject({ tenantId: 'tenant-a', sub: 'person-a', accessToken: 'synthetic-token' });
});

it('caps custody at token expiry without extending it on reads', async () => {
  const { custody, clock } = fixture();
  const data = input();
  data.tokenExpiresAt = new Date(NOW + 60_000);
  const made = await custody.create(data);
  expect(made.expiresAt.getTime()).toBe(NOW + 60_000);
  clock.now += 30_000;
  expect((await custody.read(made.cookie))?.expiresAt.getTime()).toBe(NOW + 60_000);
  clock.now += 30_000;
  expect(await custody.read(made.cookie)).toBeUndefined();
});

it('rejects invalid cookies before any tenant lookup and never falls back after store failure', async () => {
  const { repository, custody } = fixture();
  expect(await custody.read('malformed')).toBeUndefined();
  expect(repository.findActive).not.toHaveBeenCalled();
  const made = await custody.create(input());
  repository.findActive.mockRejectedValueOnce(new SessionCustodyError('unavailable'));
  await expect(custody.read(made.cookie)).rejects.toMatchObject({ code: 'unavailable' });
});

it('refuses credential swapping across handles and contexts', async () => {
  const { repository, custody } = fixture();
  const first = await custody.create(input());
  await custody.create(input());
  const rows = [...repository.rows.values()];
  rows[0]!.credential = rows[1]!.credential;
  await expect(custody.read(first.cookie)).rejects.toMatchObject({ code: 'invalid' });
});

it.each(['sub', 'issuedAt', 'createdAt', 'expiresAt', 'tenantId', 'handleHash'] as const)('refuses altered stored %s metadata', async (field) => {
  const { repository, custody } = fixture();
  const made = await custody.create(input());
  const row = [...repository.rows.values()][0]!;
  if (field === 'sub') row.sub = 'other';
  else if (field === 'issuedAt') row.issuedAt--;
  else if (field === 'createdAt') row.createdAt = new Date(NOW - 1);
  else if (field === 'expiresAt') row.expiresAt = new Date(NOW + 1);
  else if (field === 'tenantId') row.tenantId = 'foreign';
  else row.handleHash = 'a'.repeat(64);
  await expect(custody.read(made.cookie)).rejects.toMatchObject({ code: 'invalid' });
});

it('revokes only the addressed cookie and never returns a cookie when persistence fails', async () => {
  const { repository, custody } = fixture();
  const first = await custody.create(input());
  const second = await custody.create(input());
  expect(await custody.revoke(first.cookie)).toBe(true);
  expect(await custody.read(first.cookie)).toBeUndefined();
  expect(await custody.read(second.cookie)).toBeDefined();
  expect(await custody.revoke(first.cookie)).toBe(false);
  expect(await custody.revoke('bad')).toBe(false);
  repository.insert.mockRejectedValueOnce(new SessionCustodyError('unavailable'));
  await expect(custody.create(input())).rejects.toMatchObject({ code: 'unavailable' });
});

it.each(['tenant', 'subject', 'issuedAt', 'expired', 'invalidDate'] as const)('refuses invalid creation input: %s', async (which) => {
  const { repository, custody } = fixture();
  const data = input();
  if (which === 'tenant') data.identity.tenantId = '';
  if (which === 'subject') data.identity.sub = 'system:job';
  if (which === 'issuedAt') data.identity.issuedAt = NOW / 1000 + 31;
  if (which === 'expired') data.tokenExpiresAt = new Date(NOW);
  if (which === 'invalidDate') data.tokenExpiresAt = new Date(NaN);
  await expect(custody.create(data)).rejects.toMatchObject({ code: 'invalid' });
  expect(repository.insert).not.toHaveBeenCalled();
});
