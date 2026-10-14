import { type DuplicateCandidateDto, duplicateCandidateDtoSchema, type PatientMergeDto, patientMergeDtoSchema } from '@telesphoros/shared-types';
import type { MergeStatus } from '../storage/ledger-records';
import type { DuplicateCandidate } from '../storage/patient-identifiers.repository';

/** Allow-lists. Neither the people who proposed or decided, nor any identifier or digest, can reach a response. */
export function toMergeDto(status: MergeStatus): PatientMergeDto {
  const { proposal, decision } = status;
  return patientMergeDtoSchema.parse({
    id: proposal.id,
    kind: proposal.mergeKind,
    sourcePatientId: proposal.sourcePatientId,
    targetPatientId: proposal.targetPatientId,
    reasonCode: proposal.reasonCode,
    proposedAt: proposal.createdAt,
    status: status.status,
    decidedAt: decision ? decision.createdAt : null,
  });
}

export function toDuplicateDto(candidate: DuplicateCandidate): DuplicateCandidateDto {
  return duplicateCandidateDtoSchema.parse({
    patientId: candidate.patientId,
    patientLabel: candidate.patientLabel,
    otherPatientId: candidate.otherPatientId,
    otherPatientLabel: candidate.otherPatientLabel,
    system: candidate.system,
    flaggedAt: candidate.flaggedAt.toISOString(),
  });
}
