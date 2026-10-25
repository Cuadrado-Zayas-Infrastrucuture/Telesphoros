import { randomBytes } from 'node:crypto';
import { SessionCrypto } from './session-crypto';
import { SessionCustodyError } from '../storage/browser-session.repository';

const make = () => new SessionCrypto('current', new Map([['current', randomBytes(32)]]));
const locator = (crypto: SessionCrypto) => ({ tenantId: 'tenant-a', handle: crypto.newHandle(), expiresAt: Date.now() + 60_000 });
const flip = (value: string, part: number) => {
  const parts = value.split('.');
  const bytes = Buffer.from(parts[part]!, 'base64url');
  bytes[0] = bytes[0]! ^ 1;
  parts[part] = bytes.toString('base64url');
  return parts.join('.');
};

it('seals and opens credentials only in their exact authenticated context', () => {
  const crypto = make();
  const a = crypto.sealCredential('synthetic-access-token', 'tenant-a/session-a');
  const b = crypto.sealCredential('synthetic-access-token', 'tenant-a/session-a');
  expect(a).not.toBe(b);
  expect(a).not.toContain('synthetic-access-token');
  expect(crypto.openCredential(a, 'tenant-a/session-a')).toBe('synthetic-access-token');
  for (const context of ['tenant-b/session-a', 'tenant-a/session-b', '']) expect(() => crypto.openCredential(a, context)).toThrow(SessionCustodyError);
});

it('keeps tenant locators opaque, canonical and independent of credential envelopes', () => {
  const crypto = make();
  const input = locator(crypto);
  const sealed = crypto.sealLocator(input);
  expect(sealed).not.toContain(input.tenantId);
  expect(sealed).not.toContain(input.handle);
  expect(crypto.openLocator(sealed)).toEqual(input);
  expect(crypto.openLocator(crypto.sealCredential(JSON.stringify(input), ''))).toBeUndefined();
  expect(() => crypto.openCredential(sealed, '')).toThrow(SessionCustodyError);
  expect(crypto.hashHandle(input.handle)).toMatch(/^[0-9a-f]{64}$/);
  expect(crypto.hashHandle(input.handle)).not.toBe(input.handle);
});

it.each([2, 3, 4])('rejects a modified nonce/ciphertext/tag (part %s)', (part) => {
  const crypto = make();
  const value = crypto.sealCredential('synthetic-token', 'binding');
  expect(() => crypto.openCredential(flip(value, part), 'binding')).toThrow('custody invalid');
  expect(crypto.openLocator(flip(crypto.sealLocator(locator(crypto)), part))).toBeUndefined();
});

it.each(['', 'v2.current.a.b.c', 'v1.unknown.a.b.c', 'v1.current.@@.b.c', 'v1.current.a.b.c.extra', 'x'.repeat(20_000)])(
  'refuses malformed/unknown envelopes without exposing input: %#',
  (value) => {
    const crypto = make();
    expect(crypto.openLocator(value)).toBeUndefined();
    try {
      crypto.openCredential(value, 'binding');
      throw new Error('accepted');
    } catch (error) {
      expect(error).toBeInstanceOf(SessionCustodyError);
      expect((error as Error).message).toBe('Browser session custody invalid');
    }
  },
);

it('rejects the wrong key and supports an explicit retained key without silently inventing one', () => {
  const old = randomBytes(32);
  const next = randomBytes(32);
  const oldCrypto = new SessionCrypto('old', new Map([['old', old]]));
  const sealed = oldCrypto.sealCredential('synthetic-token', 'binding');
  const rotated = new SessionCrypto(
    'next',
    new Map([
      ['old', old],
      ['next', next],
    ]),
  );
  expect(rotated.openCredential(sealed, 'binding')).toBe('synthetic-token');
  expect(rotated.sealCredential('synthetic-token', 'binding')).toMatch(/^v1\.next\./);
  expect(() => new SessionCrypto('old', new Map([['old', next]])).openCredential(sealed, 'binding')).toThrow(SessionCustodyError);
  expect(() => new SessionCrypto('next', new Map([['next', next]])).openCredential(sealed, 'binding')).toThrow(SessionCustodyError);
  old.fill(0); // constructor owns a copy, never the caller's mutable key buffer
  expect(oldCrypto.openCredential(sealed, 'binding')).toBe('synthetic-token');
  expect(JSON.stringify(rotated)).not.toContain(next.toString('hex'));
});

it('refuses missing, invalid and excessive key configurations', () => {
  expect(() => new SessionCrypto('absent', new Map([['other', randomBytes(32)]]))).toThrow(SessionCustodyError);
  expect(() => new SessionCrypto('bad.id', new Map([['bad.id', randomBytes(32)]]))).toThrow(SessionCustodyError);
  expect(() => new SessionCrypto('a', new Map([['a', randomBytes(31)]]))).toThrow(SessionCustodyError);
  expect(() => new SessionCrypto('a', new Map(Array.from({ length: 9 }, (_, n) => [String(n), randomBytes(32)])))).toThrow(SessionCustodyError);
});

it.each(['', 'space token', 'x'.repeat(8193)])('refuses empty/whitespace/oversized tokens (%#)', (token) => {
  expect(() => make().sealCredential(token, 'context')).toThrow(SessionCustodyError);
});

it('accepts the bounded maximum token and rejects noncanonical handles and locator payloads', () => {
  const crypto = make();
  const max = 'x'.repeat(8192);
  expect(crypto.openCredential(crypto.sealCredential(max, 'c'), 'c')).toBe(max);
  for (const handle of ['', 'a'.repeat(43), crypto.newHandle() + '=']) expect(() => crypto.hashHandle(handle)).toThrow(SessionCustodyError);
  expect(() => crypto.sealLocator({ ...locator(crypto), expiresAt: NaN })).toThrow(SessionCustodyError);
  expect(() => crypto.sealLocator({ ...locator(crypto), tenantId: '' })).toThrow(SessionCustodyError);
  expect(() => crypto.sealCredential('synthetic-token', 'x'.repeat(4097))).toThrow(SessionCustodyError);
  expect(() => crypto.openCredential(crypto.sealCredential('synthetic-token', 'c'), 'x'.repeat(4097))).toThrow(SessionCustodyError);
});
