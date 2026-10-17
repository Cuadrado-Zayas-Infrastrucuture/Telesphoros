/** Internal custody only. A stored session never establishes current membership or roles. */
export interface BrowserSessionRecord {
  tenantId: string;
  handleHash: string;
  sub: string;
  issuedAt: number;
  createdAt: Date;
  expiresAt: Date;
  credential: string;
}

export class SessionCustodyError extends Error {
  constructor(readonly code: 'invalid' | 'unavailable') {
    super(`Browser session custody ${code}`);
    this.name = 'SessionCustodyError';
  }
}

/** No in-memory production fallback. Implementations must throw on store failure. */
export abstract class BrowserSessionRepository {
  abstract insert(record: BrowserSessionRecord): Promise<void>;
  abstract findActive(tenantId: string, handleHash: string): Promise<BrowserSessionRecord | undefined>;
  abstract revoke(tenantId: string, handleHash: string): Promise<boolean>;
  abstract cleanupExpired(tenantId: string, limit: number): Promise<number>;
}
