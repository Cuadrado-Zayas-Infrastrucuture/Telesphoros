import { Module } from '@nestjs/common';
import { ENV, type Env } from '../config/env';
import { createFieldKeyProvider, FIELD_KEY_PROVIDER } from './field-key-provider';
import { PatientDemographicsController } from './patient-demographics.controller';
import { PatientDemographicsService } from './patient-demographics.service';

/**
 * Patient demographics with encrypted identity (spec 025). The key provider is chosen from the environment here and nowhere else: KMS in a deployed build, the
 * local provider in development and tests (env.ts refuses it in production, and so does the factory).
 */
@Module({
  controllers: [PatientDemographicsController],
  providers: [PatientDemographicsService, { provide: FIELD_KEY_PROVIDER, inject: [ENV], useFactory: (env: Env) => createFieldKeyProvider(env) }],
})
export class PatientDemographicsModule {}
