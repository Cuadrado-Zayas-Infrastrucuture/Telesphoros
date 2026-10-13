import { type IdentifierDto, identifierDtoSchema, type PatientLinkDecisionDto, patientLinkDecisionDtoSchema, type PatientLinkDto, patientLinkDtoSchema } from '@telesphoros/shared-types';
import type { Projected } from '../storage/ledger-records';
import type { IdentifierRecord } from '../storage/patient-identifiers.repository';
import type { LinkState } from './link-state';

/** Allow-lists. Neither the digest, the key version, who registered an identifier, nor the identifier a decision matched can reach a response. */
export function toIdentifierDto(record: IdentifierRecord): IdentifierDto {
  return identifierDtoSchema.parse({
    id: record.id,
    patientId: record.patientId,
    system: record.system,
    status: record.status,
    createdAt: record.createdAt.toISOString(),
    withdrawnAt: record.withdrawnAt ? record.withdrawnAt.toISOString() : null,
  });
}

export function toDecisionDto(record: Projected): PatientLinkDecisionDto {
  return patientLinkDecisionDtoSchema.parse({
    id: record.id,
    decision: record.decision,
    method: record.method,
    basisCode: record.basisCode ?? null,
    createdAt: record.createdAt,
  });
}

export function toLinkDto(reportId: string, patientId: string, link: LinkState): PatientLinkDto {
  return patientLinkDtoSchema.parse({
    reportId,
    patientId,
    state: link.state,
    decision: link.decision ? toDecisionDto(link.decision) : null,
    staleDecision: link.stale,
  });
}
