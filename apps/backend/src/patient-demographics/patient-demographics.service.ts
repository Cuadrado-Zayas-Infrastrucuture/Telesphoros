import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  ageFromBirthYear,
  DEMOGRAPHICS_REFUSAL_REASONS,
  ErrorCode,
  type PatientDemographicsDto,
  type PatientDemographicsInput,
  type PatientDemographicsVersion,
} from '@telesphoros/shared-types';
import type { Principal } from '../auth/principal';
import { AppException } from '../common/app-exception';
import { PatientsRepository } from '../storage/patients.repository';
import {
  DemographicsRequestRaceError,
  FieldKeyRaceError,
  IdentityErasedError,
  PatientDemographicsRepository,
  type StoredDemographics,
  type StoredFieldKey,
} from '../storage/patient-demographics.repository';
import { type DataKeyContext, FIELD_KEY_PROVIDER, FieldKeyError, type FieldKeyProvider } from './field-key-provider';
import { type IdentityBinding, IdentityCryptoError, openField, requestFingerprint, sealField } from './identity-crypto';

/** More than this many lost races in a row means something other than ordinary concurrency; answer busy instead of looping. */
const MAX_ATTEMPTS = 3;

/**
 * Patient demographics (spec 025, PD-a). The one place that holds a patient's data key.
 *
 * Writing: derive the birth year from the date of birth HERE (the database never sees the date, PD-4), seal the three identity fields under the patient's data key
 * with associated data that binds tenant, patient, field and key version (PD-2), and store the ciphertext with the coded columns. The first version also
 * stores the wrapped key, in the same transaction.
 *
 * Reading: the detail read unwraps the key (KMS records the unwrap) and decrypts one version. Nothing else in the application decrypts: lists are built from
 * the coded columns alone and are not given the provider (PD-6).
 *
 * No message built here contains a name, a date of birth, a key or a ciphertext.
 */
@Injectable()
export class PatientDemographicsService {
  private readonly logger = new Logger('PatientDemographics');

  constructor(
    private readonly patients: PatientsRepository,
    private readonly demographics: PatientDemographicsRepository,
    @Inject(FIELD_KEY_PROVIDER) private readonly keys: FieldKeyProvider,
  ) {}

  /** Creates the patient's first version, or a correction: a new version, never an overwrite. A repeat of the same request returns the version it created. */
  async record(principal: Principal, patientId: string, input: PatientDemographicsInput): Promise<PatientDemographicsDto> {
    const tenant = principal.tenantId;
    // Someone else's patient is reported as NOT_FOUND, so ids cannot be probed for existence.
    if (!(await this.patients.findById(tenant, patientId))) throw AppException.notFound('Patient not found.');
    const context: DataKeyContext = { tenant, patient: patientId };
    const fingerprintParts = [patientId, input.givenName, input.familyName, input.dateOfBirth, input.sex, input.ethnicity] as const;

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      if (input.requestId) {
        const replayed = await this.replay(principal, context, input.requestId, fingerprintParts);
        if (replayed) return replayed;
      }
      const state = await this.demographics.keyState(tenant, patientId);
      let dataKey: Buffer;
      let keyVersion: number;
      let newKey: { keyVersion: number; wrapped: Buffer; provider: string } | undefined;
      if (state.key) {
        dataKey = await this.openKey(state.key, context);
        keyVersion = state.key.keyVersion;
      } else if (state.hasVersions) {
        throw erased();
      } else {
        const generated = await this.generate(context);
        dataKey = generated.plaintext;
        keyVersion = 1;
        newKey = { keyVersion, wrapped: generated.wrapped, provider: this.keys.id };
      }
      try {
        const binding: IdentityBinding = { tenant, patient: patientId, keyVersion };
        const stored = await this.demographics.insertVersion(tenant, principal.sub, {
          id: randomUUID(),
          patientId,
          keyVersion,
          givenName: sealField(dataKey, binding, 'given_name', input.givenName),
          familyName: sealField(dataKey, binding, 'family_name', input.familyName),
          dateOfBirth: sealField(dataKey, binding, 'date_of_birth', input.dateOfBirth),
          sex: input.sex,
          // PD-4: the year is DERIVED from the date, never taken from the caller. The input schema has already proved the date is real and in range.
          birthYear: Number(input.dateOfBirth.slice(0, 4)),
          ethnicity: input.ethnicity,
          ...(input.requestId ? { request: { id: input.requestId, hash: requestFingerprint(dataKey, fingerprintParts) } } : {}),
          ...(newKey ? { newKey } : {}),
        });
        return await this.present(dataKey, context, stored, [...(await this.demographics.versions(tenant, patientId))]);
      } catch (error) {
        // Lost a race with another request for the same patient (its key, or the same retry id): look again, once the winner has committed.
        if (error instanceof FieldKeyRaceError || error instanceof DemographicsRequestRaceError) continue;
        if (error instanceof IdentityErasedError) throw erased();
        throw error;
      } finally {
        dataKey.fill(0);
      }
    }
    throw AppException.ledgerBusy();
  }

  /** The detail read: one version decrypted (the current one unless `version` names another), and the list of every version. Clinical read roles only (the controller). */
  async read(principal: Principal, patientId: string, version?: number): Promise<PatientDemographicsDto> {
    const tenant = principal.tenantId;
    if (!(await this.patients.findById(tenant, patientId))) throw AppException.notFound('Patient not found.');
    const versions = await this.demographics.versions(tenant, patientId);
    if (versions.length === 0) {
      throw AppException.notFoundBecause(DEMOGRAPHICS_REFUSAL_REASONS.noDemographics, 'This patient has no demographics recorded yet.');
    }
    const selected = version === undefined ? versions[versions.length - 1]! : versions.find((v) => v.version === version);
    if (!selected) throw AppException.notFoundBecause(DEMOGRAPHICS_REFUSAL_REASONS.noDemographics, 'That version of the demographics does not exist.');
    const state = await this.demographics.keyState(tenant, patientId);
    if (!state.key) throw erased();
    const context: DataKeyContext = { tenant, patient: patientId };
    const dataKey = await this.openKey(state.key, context);
    try {
      return await this.present(dataKey, context, selected, versions);
    } finally {
      dataKey.fill(0);
    }
  }

  private async replay(principal: Principal, context: DataKeyContext, requestId: string, parts: readonly unknown[]): Promise<PatientDemographicsDto | undefined> {
    const prior = await this.demographics.findByRequest(principal.tenantId, principal.sub, requestId);
    if (!prior) return undefined;
    // The same retry id for another patient is a different request; answer without opening anything.
    if (prior.patientId !== context.patient) throw reused();
    const state = await this.demographics.keyState(context.tenant, context.patient);
    if (!state.key) throw erased();
    const dataKey = await this.openKey(state.key, context);
    try {
      if (prior.creationRequestHash !== requestFingerprint(dataKey, parts)) throw reused();
      return await this.present(dataKey, context, prior, await this.demographics.versions(context.tenant, context.patient));
    } finally {
      dataKey.fill(0);
    }
  }

  private async generate(context: DataKeyContext) {
    try {
      return await this.keys.generateDataKey(context);
    } catch (error) {
      throw this.keyFailure(error);
    }
  }

  private async openKey(key: StoredFieldKey, context: DataKeyContext): Promise<Buffer> {
    // A key wrapped by one provider is not opened by another: say so, instead of failing as if the data were damaged.
    if (key.provider !== this.keys.id) {
      throw new AppException(500, ErrorCode.INTERNAL_ERROR, 'Patient identity keys are not configured for this deployment. An operator must fix this.');
    }
    try {
      return await this.keys.unwrap(key.wrapped, context);
    } catch (error) {
      throw this.keyFailure(error);
    }
  }

  private keyFailure(error: unknown): AppException {
    if (error instanceof FieldKeyError) this.logger.error({ event: 'patient-key-error', reason: error.reason, code: error.providerCode });
    else this.logger.error({ event: 'patient-key-error', reason: 'unexpected' });
    return AppException.unavailable('The identity could not be opened just now. Nothing was changed; try again shortly.');
  }

  private async present(dataKey: Buffer, context: DataKeyContext, selected: StoredDemographics, versions: readonly StoredDemographics[]): Promise<PatientDemographicsDto> {
    const binding: IdentityBinding = { tenant: context.tenant, patient: context.patient, keyVersion: selected.keyVersion };
    let fields: { givenName: string; familyName: string; dateOfBirth: string };
    try {
      fields = {
        givenName: openField(dataKey, binding, 'given_name', selected.givenName),
        familyName: openField(dataKey, binding, 'family_name', selected.familyName),
        dateOfBirth: openField(dataKey, binding, 'date_of_birth', selected.dateOfBirth),
      };
    } catch (error) {
      if (error instanceof IdentityCryptoError) {
        this.logger.error({ event: 'patient-identity-undecryptable', reason: 'authentication-failed' });
        throw new AppException(500, ErrorCode.INTERNAL_ERROR, 'This patient’s identity could not be verified. An operator must investigate.');
      }
      throw error;
    }
    const latest = versions.length === 0 ? selected.version : versions[versions.length - 1]!.version;
    return {
      patientId: context.patient,
      version: selected.version,
      current: selected.version === latest,
      ...fields,
      sex: selected.sex,
      birthYear: selected.birthYear,
      ageYears: ageFromBirthYear(selected.birthYear),
      ethnicity: selected.ethnicity,
      createdAt: selected.createdAt,
      createdBy: selected.createdBy,
      versions: versions.map((v): PatientDemographicsVersion => ({
        version: v.version,
        createdAt: v.createdAt,
        createdBy: v.createdBy,
        sex: v.sex,
        birthYear: v.birthYear,
        ethnicity: v.ethnicity,
      })),
    };
  }
}

/** 410 Gone: the patient's key was destroyed on purpose (D8). A stable reason tells a client this is final, not a fault to retry. */
function erased(): AppException {
  const message = 'The identity of this patient has been erased. It cannot be read or changed.';
  return new AppException(410, ErrorCode.NOT_FOUND, message, [{ field: 'request', message, reason: DEMOGRAPHICS_REFUSAL_REASONS.identityErased }]);
}

function reused(): AppException {
  return AppException.conflictBecause(DEMOGRAPHICS_REFUSAL_REASONS.requestIdReused, 'That request id was already used for different demographics.');
}
