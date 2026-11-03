import { Injectable } from '@nestjs/common';
import type { StructuredFindingReviewCreate, StructuredPreview, StructuredSourceResolutionCreate } from '@telesphoros/shared-types';
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
/** The newest decision for one finding of one stored revision. Earlier decisions stay in the ledger-covered table. */
export interface StoredFindingReview {
  id: string;
  revisionId: string;
  findingId: string;
  decision: 'accepted-as-evidence' | 'rejected' | 'held';
  reasonCode: string;
  createdAt: string;
}
export interface StoredSourceResolution {
  id: string;
  laboratoryId: string;
  seriesId: string;
  revision: number;
  revisionIds: string[];
  outcome: 'use-revision' | 'none-usable' | 'keep-held';
  chosenRevisionId: string | null;
  reasonCode: string;
  createdAt: string;
}
/** Everything one patient has stored, read in a single SQL snapshot. Nothing is filtered away. */
export interface StructuredSnapshot {
  revisions: StoredStructuredRevision[];
  reviews: StoredFindingReview[];
  resolutions: StoredSourceResolution[];
}
/** Runs inside the writing transaction after its locks are held; throws a conflict when the evidence is no longer open for the decision. */
export type SnapshotCheck = (snapshot: StructuredSnapshot) => void;
export abstract class StructuredRevisionsRepository {
  abstract save(tenant: string, actor: string, preview: StructuredPreview): Promise<boolean>;
  abstract read(tenant: string, preview: StructuredPreview): Promise<StructuredSnapshot>;
  abstract recordReview(tenant: string, actor: string, preview: StructuredPreview, input: StructuredFindingReviewCreate, check: SnapshotCheck): Promise<boolean>;
  abstract recordResolution(tenant: string, actor: string, preview: StructuredPreview, input: StructuredSourceResolutionCreate, check: SnapshotCheck): Promise<boolean>;
}
@Injectable()
export class UnavailableStructuredRevisionsRepository extends StructuredRevisionsRepository {
  async save(): Promise<boolean> {
    throw AppException.unavailable('Structured records require the PostgreSQL store.');
  }
  async read(): Promise<StructuredSnapshot> {
    throw AppException.unavailable('Structured records require the PostgreSQL store.');
  }
  async recordReview(): Promise<boolean> {
    throw AppException.unavailable('Structured records require the PostgreSQL store.');
  }
  async recordResolution(): Promise<boolean> {
    throw AppException.unavailable('Structured records require the PostgreSQL store.');
  }
}
