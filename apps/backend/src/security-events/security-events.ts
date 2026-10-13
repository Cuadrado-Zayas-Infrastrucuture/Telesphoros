import { Injectable, Logger } from '@nestjs/common';
import { asOrganizationWork, currentRequestId } from '../auth/authority-context';
import { Database } from '../db/database';

/** Why a caller with a valid token was refused (the membership checks of M1.5). */
export type RefusalReason = 'no-membership' | 'removed' | 'token-revoked' | 'authority-changed' | 'tenant-suspended';

/**
 * The security-event record (docs/design/plans/m1-6-security-events.md). What the application may write: refusals (best effort, throttled by the
 * database). Membership changes are recorded by a trigger, not here. File links are not recorded here: the application access audit
 * (auth/security-audit.ts) already records every one, so recording them twice would only duplicate.
 * An event holds identifiers and short codes only: no token, URL, file name, label or patient value is ever passed in.
 */
export abstract class SecurityEvents {
  /** Never throws and never delays the refusal it describes by more than the write itself. */
  abstract recordRefusal(tenantId: string, sub: string, reason: RefusalReason): Promise<void>;
}

/** The fields of one recorded event, as the in-memory store and the tests see them. */
export interface RecordedSecurityEvent {
  tenantId: string;
  eventType: 'access.refused';
  outcome: 'succeeded' | 'refused';
  actorRef: string;
  subjectKind: 'person';
  subjectRef: string;
  requestId?: string;
  details: Record<string, string>;
  at: number;
}

/** What goes into security_event_append for a refusal (shared by both stores, so they cannot drift). */
function refusalRow(sub: string, reason: RefusalReason) {
  return { eventType: 'access.refused' as const, outcome: 'refused' as const, subjectKind: 'person' as const, subjectRef: sub, details: { reason } };
}

/** Development and tier-1 store: keeps events in memory with the same throttle as the database function. Lost on restart; production requires PostgreSQL. */
@Injectable()
export class InMemorySecurityEvents extends SecurityEvents {
  readonly events: RecordedSecurityEvent[] = [];

  async recordRefusal(tenantId: string, sub: string, reason: RefusalReason): Promise<void> {
    const row = refusalRow(sub, reason);
    const recent = this.events.some((e) => e.eventType === 'access.refused' && e.tenantId === tenantId && e.actorRef === sub && e.details.reason === reason && Date.now() - e.at < 60_000);
    if (recent) return;
    this.events.push({ tenantId, actorRef: sub, requestId: currentRequestId(), at: Date.now(), ...row });
  }
}

/** The durable store: calls the database function, which takes the organization and the person from the transaction. */
@Injectable()
export class PostgresSecurityEvents extends SecurityEvents {
  private readonly logger = new Logger('SecurityEvents');

  constructor(private readonly db: Database) {
    super();
    // A write refused at commit because the caller's membership changed under it is itself a security event.
    db.onAuthorityRefused = (tenantId, sub) => this.recordRefusal(tenantId, sub, 'authority-changed');
  }

  async recordRefusal(tenantId: string, sub: string, reason: RefusalReason): Promise<void> {
    const row = refusalRow(sub, reason);
    const requestId = currentRequestId(); // read before leaving the request's context below
    try {
      // Organization work: the person was refused, so their own authority must not decide whether the refusal is written.
      await asOrganizationWork(() => this.append(tenantId, sub, row, requestId));
    } catch (error) {
      this.logger.warn({ event: 'security-event-not-recorded', type: row.eventType, error: (error as Error).name }, 'A refusal could not be recorded');
    }
  }

  private append(tenantId: string, actor: string, row: ReturnType<typeof refusalRow>, requestId: string | undefined) {
    return this.db.withTenant(
      tenantId,
      (client) => client.query('SELECT security_event_append($1, $2, $3, $4, $5::jsonb, $6)', [row.eventType, row.outcome, row.subjectKind, row.subjectRef, JSON.stringify(row.details), requestId ?? null]),
      { actor },
    );
  }
}
