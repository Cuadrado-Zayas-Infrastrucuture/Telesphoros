import type { RecommendationStrength, ReportStatus, ReportType } from '@telesphoros/shared-types';

/** Internal records. `ownerId` lives here and is NEVER copied into a DTO. */
export interface PatientRecord {
  id: string;
  ownerId: string;
  label: string;
  createdAt: string;
  updatedAt: string;
}

export interface ReportRecord {
  id: string;
  ownerId: string;
  patientId: string;
  type: ReportType;
  filename: string;
  sizeBytes: number;
  status: ReportStatus;
  /** Set by the upload flow. The bytes live in object storage, never in the database. */
  storageKey?: string | null;
  contentType?: string | null;
  sha256?: string | null;
  uploadedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RecommendationRecord {
  id: string;
  ownerId: string;
  patientId: string;
  reportId: string;
  gene: string;
  drug: string;
  phenotype: string;
  summary: string;
  strength: RecommendationStrength;
  guidelineVersion: string;
  createdAt: string;
}

export interface PageRequest {
  offset: number;
  limit: number;
}

export interface Page<T> {
  items: T[];
  total: number;
}

/**
 * Oldest first. Timestamps can tie (same millisecond), and a random id must NOT break the tie or
 * creation order is lost. Array.sort is stable and the in-memory Map iterates in insertion order,
 * so equal timestamps keep their creation order. Phase 3 needs an explicit sequence column
 * (e.g. a bigserial) to give the database the same guarantee.
 */
export function byCreatedAt<T extends { createdAt: string }>(a: T, b: T): number {
  return a.createdAt.localeCompare(b.createdAt);
}

export function slicePage<T>(rows: T[], { offset, limit }: PageRequest): Page<T> {
  return { items: rows.slice(offset, offset + limit), total: rows.length };
}
