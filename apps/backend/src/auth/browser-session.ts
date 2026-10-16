import { tenantIdSchema } from '@telesphoros/shared-types';
import { BrowserSessionRepository, type BrowserSessionRecord, SessionCustodyError } from '../storage/browser-session.repository';
import { subjectClaim, type TokenIdentity } from './token-verifier';
import { SessionCrypto } from './session-crypto';

export const MAX_BROWSER_SESSION_MS = 15 * 60 * 1000;

/** Must be supplied by trusted code AFTER the existing token verifier succeeds. No routes consume this yet. */
export interface VerifiedSessionInput {
  identity: TokenIdentity;
  accessToken: string;
  tokenExpiresAt: Date;
}

export function sessionCredentialContext(row: Omit<BrowserSessionRecord, 'credential'>): string {
  return JSON.stringify([row.tenantId, row.handleHash, row.sub, row.issuedAt, row.createdAt.toISOString(), row.expiresAt.toISOString()]);
}

/** Custody primitives only; read() is NOT authorization, membership resolution, or write admission. */
export class BrowserSessionCustody {
  constructor(private readonly repository: BrowserSessionRepository, private readonly crypto: SessionCrypto, private readonly clock: () => number = Date.now) {}

  async create(input: VerifiedSessionInput): Promise<{ cookie: string; expiresAt: Date }> {
    const now = this.clock();
    const expiry = input.tokenExpiresAt.getTime();
    if (!Number.isSafeInteger(now) || !Number.isFinite(expiry) || expiry <= now || !Number.isSafeInteger(input.identity.issuedAt)
      || input.identity.issuedAt < 0 || input.identity.issuedAt > Math.floor(now / 1000) + 30
      || !tenantIdSchema.safeParse(input.identity.tenantId).success || !subjectClaim.safeParse(input.identity.sub).success) throw new SessionCustodyError('invalid');
    const handle = this.crypto.newHandle();
    const row = {
      tenantId: input.identity.tenantId, sub: input.identity.sub, issuedAt: input.identity.issuedAt,
      handleHash: this.crypto.hashHandle(handle), createdAt: new Date(now), expiresAt: new Date(Math.min(expiry, now + MAX_BROWSER_SESSION_MS)),
    };
    const cookie = this.crypto.sealLocator({ tenantId: row.tenantId, handle, expiresAt: row.expiresAt.getTime() });
    await this.repository.insert({ ...row, credential: this.crypto.sealCredential(input.accessToken, sessionCredentialContext(row)) });
    return { cookie, expiresAt: new Date(row.expiresAt) };
  }

  async read(cookie: string): Promise<(BrowserSessionRecord & { accessToken: string }) | undefined> {
    const locator = this.crypto.openLocator(cookie);
    if (!locator || locator.expiresAt <= this.clock()) return undefined;
    const hash = this.crypto.hashHandle(locator.handle);
    const row = await this.repository.findActive(locator.tenantId, hash);
    if (!row) return undefined;
    if (row.tenantId !== locator.tenantId || row.handleHash !== hash || row.expiresAt.getTime() !== locator.expiresAt
      || row.expiresAt.getTime() <= this.clock() || row.expiresAt.getTime() - row.createdAt.getTime() > MAX_BROWSER_SESSION_MS) throw new SessionCustodyError('invalid');
    return { ...row, accessToken: this.crypto.openCredential(row.credential, sessionCredentialContext(row)) };
  }

  async revoke(cookie: string): Promise<boolean> {
    const locator = this.crypto.openLocator(cookie);
    return locator ? this.repository.revoke(locator.tenantId, this.crypto.hashHandle(locator.handle)) : false;
  }
}
