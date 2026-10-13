import { type DynamicModule, Module } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import { LoggerModule } from 'nestjs-pino';
import { AllExceptionsFilter } from './common/all-exceptions.filter';
import { InputBoundaryInterceptor } from './common/input-boundary.interceptor';
import { AuthModule } from './auth/auth.module';
import { SecurityAuditInterceptor } from './auth/security-audit.interceptor';
import { ConfigModule } from './config/config.module';
import { ENV, type Env } from './config/env';
import { HealthModule } from './health/health.module';
import { LabReportsModule } from './lab-reports/lab-reports.module';
import { LedgerModule } from './ledger/ledger.module';
import { pinoHttpOptions } from './logger-options';
import { MeModule } from './me/me.module';
import { MembersModule } from './members/members.module';
import { ObjectStorageModule } from './object-storage/object-storage.module';
import type { RecoveryObjectStorage } from './object-storage/recovery-object-storage';
import { PatientsModule } from './patients/patients.module';
import { RecommendationsModule } from './recommendations/recommendations.module';
import { ReportsModule } from './reports/reports.module';
import { StorageModule } from './storage/storage.module';

@Module({})
export class AppModule {
  static register(env: Env, recovery?: RecoveryObjectStorage): DynamicModule {
    return {
      module: AppModule,
      imports: [
        ConfigModule.forRoot(env),
        LoggerModule.forRootAsync({
          inject: [ENV],
          useFactory: (config: Env) => ({
            pinoHttp: pinoHttpOptions(config),
          }),
        }),
        AuthModule,
        LedgerModule,
        StorageModule.register(env),
        ObjectStorageModule.register(env, recovery),
        LabReportsModule,
        PatientsModule,
        ReportsModule,
        RecommendationsModule,
        HealthModule,
        MeModule,
        MembersModule,
      ],
      providers: [
        { provide: APP_FILTER, useClass: AllExceptionsFilter },
        { provide: APP_INTERCEPTOR, useClass: SecurityAuditInterceptor },
        { provide: APP_INTERCEPTOR, useClass: InputBoundaryInterceptor },
      ],
    };
  }
}
