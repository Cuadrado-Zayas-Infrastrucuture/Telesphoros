import { Injectable } from '@nestjs/common';
import type { StructuredPreview } from '@telesphoros/shared-types';
import { AppException } from '../common/app-exception';
export interface StoredStructuredRevision {
  id: string;
  reportId: string;
  patientId: string;
  sha256: string;
  objectVersion: string;
  patientLinkDecisionId: string;
  createdAt: string;
  laboratoryReport: StructuredPreview['laboratoryReport'];
  currentBinding: boolean;
}
export abstract class StructuredRevisionsRepository {
  abstract save(tenant: string, actor: string, preview: StructuredPreview): Promise<boolean>;
  abstract read(tenant: string, preview: StructuredPreview): Promise<StoredStructuredRevision[]>;
}
@Injectable()
export class UnavailableStructuredRevisionsRepository extends StructuredRevisionsRepository {
  async save(): Promise<boolean> {
    throw AppException.unavailable('Structured records require the PostgreSQL store.');
  }
  async read(): Promise<StoredStructuredRevision[]> {
    throw AppException.unavailable('Structured records require the PostgreSQL store.');
  }
}
