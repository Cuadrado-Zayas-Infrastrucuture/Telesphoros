import { Injectable } from '@nestjs/common';
import { AppException } from '../common/app-exception';
import { Database } from '../db/database';

export type SecurityAuditEvent = {
  type: 'api-auth' | 'private-read' | 'download-link' | 'private-write';
  outcome: 'accepted' | 'succeeded' | 'refused';
  tenantId: string | null;
  actorSub: string | null;
  routeKey: string;
  subjectId: string | null;
  requestId: string;
};

export abstract class SecurityAuditStore {
  abstract record(event: SecurityAuditEvent): Promise<void>;
}

/** Synthetic-only store. Production always uses the restricted PostgreSQL writer. */
@Injectable()
export class InMemorySecurityAuditStore extends SecurityAuditStore {
  readonly events: SecurityAuditEvent[] = [];
  async record(event: SecurityAuditEvent): Promise<void> {
    this.events.push({ ...event });
  }
}

@Injectable()
export class PostgresSecurityAuditStore extends SecurityAuditStore {
  constructor(private readonly database: Database) {
    super();
  }

  async record(event: SecurityAuditEvent): Promise<void> {
    try {
      await this.database.recordSecurityEvent(event);
    } catch {
      // A failed audit write must not release a protected response or reveal database details.
      throw AppException.unavailable('Access checks are unavailable.');
    }
  }
}
