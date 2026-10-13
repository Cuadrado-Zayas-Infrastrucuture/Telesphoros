import { Inject, Injectable } from '@nestjs/common';
import type { IdentifierCreate, IdentifierDto } from '@telesphoros/shared-types';
import type { Principal } from '../auth/principal';
import { AppException } from '../common/app-exception';
import { ENV, type Env } from '../config/env';
import { IdentifierInUseError, PatientIdentifiersRepository } from '../storage/patient-identifiers.repository';
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

  private async requirePatient(principal: Principal, patientId: string): Promise<void> {
    if (!(await this.patients.findById(principal.tenantId, patientId))) throw AppException.notFound('Patient not found.');
  }

  async add(principal: Principal, patientId: string, body: IdentifierCreate): Promise<IdentifierDto> {
    await this.requirePatient(principal, patientId);
    try {
      const stored = await this.identifiers.add(principal.tenantId, principal.sub, {
        patientId,
        system: body.system,
        digest: this.digest.digest(principal.tenantId, body.system, body.value),
        keyVersion: CURRENT_KEY_VERSION,
      });
      return toIdentifierDto(stored);
    } catch (error) {
      if (error instanceof IdentifierInUseError) throw AppException.conflictBecause('identifier-in-use', 'That identifier is already registered to a patient of this organization.');
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
