import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { Role } from '@telesphoros/shared-types';
import type { Principal } from '../auth/principal';
import {
  checkChange,
  type MembershipAdmin,
  MembershipAdminError,
  type MembershipChange,
  type MembershipGrant,
  type MembershipRecord,
  normalizeRoles,
  type TenantAdmin,
  type TenantRecord,
} from '../membership/membership';
import { checkTenantInput } from '../membership/pg-tenant-admin';
import { type InvitationView, MemberAdminRepository, MemberAdminRuleError, type MemberView, type PageRequest } from './member-admin.repository';

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
export class InMemoryMembershipRepository extends MembershipRepository implements MembershipAdmin, TenantAdmin, MemberAdminRepository {
  private readonly rows = new Map<string, MembershipRecord>();
  private readonly tenants = new Map<string, TenantRecord>();
  private readonly invitations: Array<InvitationView & { tenantId: string; digestHex: string; createdBy: string; requestId?: string; requestHash?: string }> = [];
  /** Changed-at per membership, for the member list. */
  private readonly changedAt = new Map<string, Date>();

  private key(tenantId: string, sub: string) {
    return `${tenantId}\u0000${sub}`;
  }

  async find(tenantId: string, sub: string): Promise<MembershipRecord | undefined> {
    const row = this.rows.get(this.key(tenantId, sub));
    return row ? { ...row, roles: [...row.roles], tenantActive: this.tenants.get(tenantId)?.status === 'active' } : undefined;
  }

  async show(tenantId: string, sub: string) {
    const row = this.rows.get(this.key(tenantId, sub));
    return row ? { ...row, roles: [...row.roles] } : undefined;
  }

  async grant(input: MembershipGrant): Promise<MembershipRecord> {
    checkChange(input);
    const roles = normalizeRoles(input.roles);
    if (!this.tenants.has(input.tenantId)) throw new MembershipAdminError('unknown-tenant', 'That organization is not registered. Register it first with `tenant create`.');
    const existing = this.rows.get(this.key(input.tenantId, input.sub));
    if (existing?.status === 'active')
      throw new MembershipAdminError('already-active', 'That person is already an active member of this organization. Use set-roles to change their roles.');
    if (this.activeElsewhere(input.tenantId, input.sub))
      throw new MembershipAdminError('in-another-organization', 'That person is an active member of another organization. Remove them there first.');
    const record: MembershipRecord = existing
      ? { ...existing, status: 'active', roles, tokensValidAfter: Math.max(existing.tokensValidAfter, this.instant(input)), version: existing.version + 1 }
      : { tenantId: input.tenantId, sub: input.sub, status: 'active', roles, tokensValidAfter: 0, version: 1 };
    this.store(record);
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
    if (!this.tenants.has(tenantId)) this.tenants.set(tenantId, { id: tenantId, displayName: tenantId, status: 'active' });
    for (const row of this.rows.values()) {
      if (row.sub === sub && row.tenantId !== tenantId && row.status === 'active')
        this.rows.set(this.key(row.tenantId, sub), { ...row, status: 'removed', version: row.version + 1 });
    }
    const existing = this.rows.get(this.key(tenantId, sub));
    if (!existing) {
      this.store({ tenantId, sub, status: 'active', roles: wanted, tokensValidAfter: 0, version: 1 });
    } else if (existing.status !== 'active' || existing.roles.join() !== wanted.join()) {
      this.store({ ...existing, status: 'active', roles: wanted, version: existing.version + 1 });
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
    this.changedAt.set(this.key(record.tenantId, record.sub), new Date());
    return { ...record, roles: [...record.roles] };
  }

  // --- the organization registry (operator command) ---

  async registerTenant(input: { id: string; displayName: string; by: string }): Promise<TenantRecord> {
    checkTenantInput(input.id, input.displayName, input.by);
    if (this.tenants.has(input.id)) throw new MembershipAdminError('invalid', 'That organization is already registered.');
    const record: TenantRecord = { id: input.id, displayName: input.displayName.trim(), status: 'active' };
    this.tenants.set(input.id, record);
    return { ...record };
  }

  async setTenantStatus(input: { id: string; status: 'active' | 'suspended'; by: string }): Promise<TenantRecord> {
    checkTenantInput(input.id, undefined, input.by);
    const existing = this.tenants.get(input.id);
    if (!existing) throw new MembershipAdminError('unknown-tenant', 'That organization is not registered.');
    const record = { ...existing, status: input.status };
    this.tenants.set(input.id, record);
    return { ...record };
  }

  async listTenants(): Promise<TenantRecord[]> {
    return [...this.tenants.values()].sort((a, b) => a.id.localeCompare(b.id)).map((t) => ({ ...t }));
  }

  // --- member administration, as an organization administrator does it (the same rules as the database functions) ---

  private context(actor: Principal): void {
    const tenant = this.tenants.get(actor.tenantId);
    if (tenant?.status !== 'active') throw new MemberAdminRuleError('tenant-inactive');
    const me = this.rows.get(this.key(actor.tenantId, actor.sub));
    if (!me || me.status !== 'active' || !me.roles.includes('admin')) throw new MemberAdminRuleError('not-administrator');
  }

  private otherActiveAdmin(tenantId: string, sub: string): boolean {
    return [...this.rows.values()].some((r) => r.tenantId === tenantId && r.sub !== sub && r.status === 'active' && r.roles.includes('admin'));
  }

  async listMembers(tenantId: string, { offset, limit }: PageRequest): Promise<{ items: MemberView[]; total: number }> {
    const all = [...this.rows.values()].filter((r) => r.tenantId === tenantId && r.status === 'active').sort((a, b) => a.sub.localeCompare(b.sub));
    return {
      items: all.slice(offset, offset + limit).map((r) => ({ sub: r.sub, roles: [...r.roles], changedAt: this.changedAt.get(this.key(r.tenantId, r.sub)) ?? new Date(0) })),
      total: all.length,
    };
  }

  /** Mirrors member_sign_out(): the caller's own active row only, and idempotent for a person with no active membership. */
  async signOut(actor: Principal): Promise<void> {
    const existing = this.rows.get(this.key(actor.tenantId, actor.sub));
    if (!existing || existing.status !== 'active') return;
    this.store({ ...existing, tokensValidAfter: Math.max(existing.tokensValidAfter, nowSeconds()), version: existing.version + 1 });
  }

  /** Mirrors the tenants_own policy: only the actor's own organization is readable. */
  async organizationName(actor: Principal): Promise<string> {
    const tenant = this.tenants.get(actor.tenantId);
    if (!tenant) throw new Error('The caller’s organization is not registered.');
    return tenant.displayName;
  }

  async changeRoles(actor: Principal, sub: string, roles: Role[]): Promise<void> {
    this.context(actor);
    if (sub === actor.sub) throw new MemberAdminRuleError('member-self');
    const target = this.rows.get(this.key(actor.tenantId, sub));
    if (!target || target.status !== 'active') throw new MemberAdminRuleError('member-not-found');
    const wanted = normalizeRoles(roles);
    if (wanted.join() === target.roles.join()) return;
    if (target.roles.includes('admin') && !wanted.includes('admin') && !this.otherActiveAdmin(actor.tenantId, sub)) throw new MemberAdminRuleError('last-administrator');
    this.store({ ...target, roles: wanted, version: target.version + 1 });
  }

  async removeMember(actor: Principal, sub: string): Promise<void> {
    this.context(actor);
    if (sub === actor.sub) throw new MemberAdminRuleError('member-self');
    const target = this.rows.get(this.key(actor.tenantId, sub));
    if (!target || target.status !== 'active') throw new MemberAdminRuleError('member-not-found');
    if (target.roles.includes('admin') && !this.otherActiveAdmin(actor.tenantId, sub)) throw new MemberAdminRuleError('last-administrator');
    this.store({ ...target, status: 'removed', tokensValidAfter: Math.max(target.tokensValidAfter, nowSeconds()), version: target.version + 1 });
  }

  async createInvitation(actor: Principal, invitation: { digest: Buffer; hint: string; roles: Role[]; request?: { id: string; hash: string } }): Promise<InvitationView> {
    this.context(actor);
    if (invitation.request) {
      const prior = this.invitations.find((i) => i.tenantId === actor.tenantId && i.createdBy === actor.sub && i.requestId === invitation.request!.id);
      if (prior) {
        if (prior.requestHash !== invitation.request.hash) throw new MemberAdminRuleError('request-id-reused');
        return this.viewOf(prior);
      }
    }
    const digestHex = invitation.digest.toString('hex');
    const now = Date.now();
    const live = this.invitations.filter((i) => i.tenantId === actor.tenantId && i.status === 'pending' && i.expiresAt.getTime() > now);
    if (live.length >= 100) throw new MemberAdminRuleError('invitation-limit');
    if (live.some((i) => i.digestHex === digestHex)) throw new MemberAdminRuleError('invitation-pending');
    const made = {
      id: randomUUID(),
      emailHint: invitation.hint,
      roles: normalizeRoles(invitation.roles),
      status: 'pending' as const,
      expiresAt: new Date(now + 14 * 86_400_000),
      createdAt: new Date(now),
      tenantId: actor.tenantId,
      digestHex,
      createdBy: actor.sub,
      ...(invitation.request ? { requestId: invitation.request.id, requestHash: invitation.request.hash } : {}),
    };
    this.invitations.push(made);
    return this.viewOf(made);
  }

  async listInvitations(tenantId: string, { offset, limit }: PageRequest): Promise<{ items: InvitationView[]; total: number }> {
    const all = this.invitations.filter((i) => i.tenantId === tenantId).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    return { items: all.slice(offset, offset + limit).map((i) => this.viewOf(i)), total: all.length };
  }

  async cancelInvitation(actor: Principal, id: string): Promise<void> {
    this.context(actor);
    const found = this.invitations.find((i) => i.id === id && i.tenantId === actor.tenantId && i.status === 'pending');
    if (!found) throw new MemberAdminRuleError('invitation-not-found');
    found.status = 'cancelled';
  }

  private viewOf(i: InvitationView & { tenantId: string; digestHex: string; createdBy: string }): InvitationView {
    return {
      id: i.id,
      emailHint: i.emailHint,
      roles: [...i.roles],
      status: i.status === 'pending' && i.expiresAt.getTime() <= Date.now() ? 'expired' : i.status,
      expiresAt: i.expiresAt,
      createdAt: i.createdAt,
    };
  }
}
