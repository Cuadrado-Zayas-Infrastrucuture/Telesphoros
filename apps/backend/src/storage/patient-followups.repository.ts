import { Injectable } from '@nestjs/common';
import type { FollowupDto, FollowupInput, FollowupList, FollowupQuery, FollowupInboxFilters, FollowupResponseSummary } from '@telesphoros/shared-types';
import { AppException } from '../common/app-exception';
export abstract class PatientFollowupsRepository {
  abstract summary(tenant: string): Promise<FollowupResponseSummary>;
  abstract read(tenant: string, patient: string | null, query: FollowupQuery & Partial<FollowupInboxFilters>, actor: string): Promise<FollowupList>;
  abstract record(tenant: string, actor: string, patient: string, input: FollowupInput): Promise<FollowupDto>;
  abstract assignees(tenant: string): Promise<string[]>;
}
@Injectable()
export class UnavailablePatientFollowupsRepository extends PatientFollowupsRepository {
  async summary(): Promise<FollowupResponseSummary> {
    throw AppException.unavailable('Follow-up summaries need the PostgreSQL store.');
  }
  async read(): Promise<FollowupList> {
    throw AppException.unavailable('Follow-ups need the PostgreSQL store.');
  }
  async record(): Promise<FollowupDto> {
    throw AppException.unavailable('Follow-ups need the PostgreSQL store.');
  }
  async assignees(): Promise<string[]> {
    throw AppException.unavailable('Follow-ups need the PostgreSQL store.');
  }
}
