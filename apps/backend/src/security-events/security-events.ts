import { Injectable, Logger } from '@nestjs/common';
import { currentRequestId } from '../auth/authority-context';
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
  /** A file the intake refused (M2.2a): who tried and a short code for why, never the file, its name, its hash or the report. Same guarantees as `recordRefusal`. */
  abstract recordIntakeRejected(tenantId: string, sub: string, reason: IntakeRejectionReason): Promise<void>;
}

/** Why the validated intake refused a file (the structural check, the declared size or hash, or the transfer limits). */
export type IntakeRejectionReason = 'structure' | 'size' | 'checksum' | 'timeout' | 'slow';

export type SecurityEventType = 'access.refused' | 'intake.rejected';

/** The fields of one recorded event, as the in-memory store and the tests see them. */
export interface RecordedSecurityEvent {
  tenantId: string;
  eventType: SecurityEventType;
  outcome: 'succeeded' | 'refused';
  actorRef: string;
  subjectKind: 'person';
  subjectRef: string;
  requestId?: string;
  details: Record<string, string>;
  at: number;
}

/** What goes into security_event_append for a refusal (shared by both stores, so they cannot drift). */
function eventRow(eventType: SecurityEventType, sub: string, reason: RefusalReason | IntakeRejectionReason) {
  return { eventType, outcome: 'refused' as const, subjectKind: 'person' as const, subjectRef: sub, details: { reason } };
}

/** Development and tier-1 store: keeps events in memory with the same throttle as the database function. Lost on restart; production requires PostgreSQL. */
@Injectable()
export class InMemorySecurityEvents extends SecurityEvents {
  readonly events: RecordedSecurityEvent[] = [];

  async recordRefusal(tenantId: string, sub: string, reason: RefusalReason): Promise<void> {
    this.record(tenantId, eventRow('access.refused', sub, reason));
  }

  async recordIntakeRejected(tenantId: string, sub: string, reason: IntakeRejectionReason): Promise<void> {
    this.record(tenantId, eventRow('intake.rejected', sub, reason));
  }

  private record(tenantId: string, row: ReturnType<typeof eventRow>): void {
    const recent = this.events.some(
      (e) => e.eventType === row.eventType && e.tenantId === tenantId && e.actorRef === row.subjectRef && e.details.reason === row.details.reason && Date.now() - e.at < 60_000,
    );
    if (recent) return;
    this.events.push({ tenantId, actorRef: row.subjectRef, requestId: currentRequestId(), at: Date.now(), ...row });
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
    await this.write(tenantId, sub, eventRow('access.refused', sub, reason));
  }

  async recordIntakeRejected(tenantId: string, sub: string, reason: IntakeRejectionReason): Promise<void> {
    await this.write(tenantId, sub, eventRow('intake.rejected', sub, reason));
  }

  private async write(tenantId: string, sub: string, row: ReturnType<typeof eventRow>): Promise<void> {
    const requestId = currentRequestId();
    try {
      // Not `withTenant`: the person was refused, so their own authority must not decide whether the refusal is written, and a refusal made late in a
      // long request (a slow upload) is recorded under the request's capability even after it expired, within the database's grace window (spec 015).
      await this.db.appendSecurityEvent(tenantId, sub, { ...row, requestId });
    } catch (error) {
      // An event that is lost must be findable: this is the only trace of it.
      this.logger.error({ event: 'security-event-not-recorded', type: row.eventType, error: (error as Error).name }, 'A security event could not be recorded');
    }
  }
}
