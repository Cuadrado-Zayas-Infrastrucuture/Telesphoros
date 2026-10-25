import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { IdentifierCreate, IdentifierDto } from '@telesphoros/shared-types';
import type { Principal } from '../auth/principal';
import { AppException } from '../common/app-exception';
import { ENV, type Env } from '../config/env';
import { IdentifierInUseError, IdentifierRequestReusedError, PatientIdentifiersRepository } from '../storage/patient-identifiers.repository';
import { PatientsRepository } from '../storage/patients.repository';
import { CURRENT_KEY_VERSION, IdentifierDigest } from './identifier-digest';
import { toIdentifierDto } from './patient-identity.mapper';

/**
 * The identifiers of a patient. The value arrives once, is turned into a keyed digest and is held by nothing: not a row, not a log line, not an
 * event, not a response. Everything is scoped to the caller's organization; another organization's patient is the same 404 as none.
 */
@Injectable()
export class PatientIdentityService {
  private readonly digest: IdentifierDigest;

  constructor(
    private readonly patients: PatientsRepository,
    private readonly identifiers: PatientIdentifiersRepository,
    @Inject(ENV) env: Env,
  ) {
    this.digest = new IdentifierDigest(env.IDENTIFIER_DIGEST_KEY);
  }

  private async requirePatient(principal: Principal, patientId: string): Promise<{ mergedInto: string | null }> {
    const patient = await this.patients.findById(principal.tenantId, patientId);
    if (!patient) throw AppException.notFound('Patient not found.');
    return { mergedInto: patient.mergedInto ?? null };
  }

  async add(principal: Principal, patientId: string, body: IdentifierCreate): Promise<IdentifierDto> {
    const patient = await this.requirePatient(principal, patientId);
    // A merged-away patient keeps its identifiers but takes no new ones: they belong on the patient it was merged into.
    if (patient.mergedInto) throw AppException.conflictBecause('patient-merged', `That patient was merged into patient ${patient.mergedInto}. Register the identifier there.`);
    const digest = this.digest.digest(principal.tenantId, body.system, body.value);
    try {
      const stored = await this.identifiers.add(principal.tenantId, principal.sub, {
        patientId,
        system: body.system,
        digest,
        keyVersion: CURRENT_KEY_VERSION,
        // The fingerprint of the original request: the patient, the system and the keyed digest, never the value.
        ...(body.requestId
          ? {
              request: {
                id: body.requestId,
                hash: createHash('sha256')
                  .update(JSON.stringify([patientId.toLowerCase(), body.system, digest.toString('hex')]))
                  .digest('hex'),
              },
            }
          : {}),
      });
      return toIdentifierDto(stored);
    } catch (error) {
      if (error instanceof IdentifierRequestReusedError) throw AppException.conflictBecause('request-id-reused', 'That request id was already used for a different identifier.');
      if (error instanceof IdentifierInUseError)
        throw AppException.conflictBecause('identifier-in-use', 'That identifier is already registered to a patient of this organization.');
      throw error;
    }
  }

  async list(principal: Principal, patientId: string): Promise<IdentifierDto[]> {
    await this.requirePatient(principal, patientId);
    return (await this.identifiers.list(principal.tenantId, patientId)).map(toIdentifierDto);
  }

  async withdraw(principal: Principal, patientId: string, identifierId: string): Promise<void> {
    await this.requirePatient(principal, patientId);
    if (!(await this.identifiers.withdraw(principal.tenantId, principal.sub, patientId, identifierId))) throw AppException.notFound('Identifier not found.');
  }
}
