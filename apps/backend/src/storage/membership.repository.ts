import { Injectable } from '@nestjs/common';
import {
  checkChange,
  type MembershipAdmin,
  MembershipAdminError,
  type MembershipChange,
  type MembershipGrant,
  type MembershipRecord,
  normalizeRoles,
} from '../membership/membership';

/**
 * Read side of live membership: the one lookup the API makes on every protected request. Anything it cannot answer (database down,
 * timeout, malformed row) must throw, never return "no membership" or a guess: the caller turns a throw into 503 and does no work.
 */
export abstract class MembershipRepository {
  abstract find(tenantId: string, sub: string): Promise<MembershipRecord | undefined>;
}

const nowSeconds = () => Math.floor(Date.now() / 1000);

/**
 * Development/test store. It has the same rules as the table (one active organization per person, a version that moves on every change, a
 * revocation instant that never moves back, rows never deleted), so tier-1 tests exercise the same behavior; it cannot show the
 * commit-time lock, which is a PostgreSQL guarantee and is proved against PostgreSQL.
 */
@Injectable()
export class InMemoryMembershipRepository extends MembershipRepository implements MembershipAdmin {
  private readonly rows = new Map<string, MembershipRecord>();

  private key(tenantId: string, sub: string) {
    return `${tenantId}\u0000${sub}`;
  }

  async find(tenantId: string, sub: string): Promise<MembershipRecord | undefined> {
    const row = this.rows.get(this.key(tenantId, sub));
    return row ? { ...row, roles: [...row.roles] } : undefined;
  }

  async show(tenantId: string, sub: string) {
    const row = this.rows.get(this.key(tenantId, sub));
    return row ? { ...row, roles: [...row.roles] } : undefined;
  }

  async grant(input: MembershipGrant): Promise<MembershipRecord> {
    checkChange(input);
    const roles = normalizeRoles(input.roles);
    const existing = this.rows.get(this.key(input.tenantId, input.sub));
    if (existing?.status === 'active') throw new MembershipAdminError('already-active', 'That person is already an active member of this organization. Use set-roles to change their roles.');
    if (this.activeElsewhere(input.tenantId, input.sub)) throw new MembershipAdminError('in-another-organization', 'That person is an active member of another organization. Remove them there first.');
    const record: MembershipRecord = existing
      ? { ...existing, status: 'active', roles, tokensValidAfter: Math.max(existing.tokensValidAfter, this.instant(input)), version: existing.version + 1 }
      : { tenantId: input.tenantId, sub: input.sub, status: 'active', roles, tokensValidAfter: 0, version: 1 };
    this.rows.set(this.key(input.tenantId, input.sub), record);
    return { ...record, roles: [...record.roles] };
  }

  async setRoles(input: MembershipGrant): Promise<MembershipRecord> {
    checkChange(input);
    const roles = normalizeRoles(input.roles);
    const existing = this.requireActive(input);
    return this.store({ ...existing, roles, version: existing.version + 1 });
  }

  async remove(input: MembershipChange): Promise<MembershipRecord> {
    checkChange(input);
    const existing = this.requireActive(input);
    return this.store({ ...existing, status: 'removed', tokensValidAfter: Math.max(existing.tokensValidAfter, this.instant(input)), version: existing.version + 1 });
  }

  async revokeSessions(input: MembershipChange): Promise<MembershipRecord> {
    checkChange(input);
    const existing = this.requireActive(input);
    return this.store({ ...existing, tokensValidAfter: Math.max(existing.tokensValidAfter, this.instant(input)), version: existing.version + 1 });
  }

  /**
   * Development convenience and the tests' stand-in for "the token is the authority": make the row match a verified token's claims. Only
   * wired where the in-memory store is (never production, which requires PostgreSQL), and only by MirrorTokenVerifier.
   */
  mirror(tenantId: string, sub: string, roles: readonly string[]): void {
    const wanted = normalizeRoles(roles);
    for (const row of this.rows.values()) {
      if (row.sub === sub && row.tenantId !== tenantId && row.status === 'active') this.rows.set(this.key(row.tenantId, sub), { ...row, status: 'removed', version: row.version + 1 });
    }
    const existing = this.rows.get(this.key(tenantId, sub));
    if (!existing) {
      this.rows.set(this.key(tenantId, sub), { tenantId, sub, status: 'active', roles: wanted, tokensValidAfter: 0, version: 1 });
    } else if (existing.status !== 'active' || existing.roles.join() !== wanted.join()) {
      this.rows.set(this.key(tenantId, sub), { ...existing, status: 'active', roles: wanted, version: existing.version + 1 });
    }
  }

  private instant(input: MembershipChange) {
    return input.revokedAt ? Math.floor(input.revokedAt.getTime() / 1000) : nowSeconds();
  }

  private activeElsewhere(tenantId: string, sub: string) {
    return [...this.rows.values()].some((row) => row.sub === sub && row.tenantId !== tenantId && row.status === 'active');
  }

  private requireActive(input: { tenantId: string; sub: string }): MembershipRecord {
    const existing = this.rows.get(this.key(input.tenantId, input.sub));
    if (!existing || existing.status !== 'active') throw new MembershipAdminError('not-active', 'That person is not an active member of this organization.');
    return existing;
  }

  private store(record: MembershipRecord): MembershipRecord {
    this.rows.set(this.key(record.tenantId, record.sub), record);
    return { ...record, roles: [...record.roles] };
  }
}
