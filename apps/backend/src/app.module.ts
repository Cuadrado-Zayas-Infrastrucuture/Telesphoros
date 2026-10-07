import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { type DynamicModule, Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import type { Request } from 'express';
import { LoggerModule } from 'nestjs-pino';
import { AllExceptionsFilter } from './common/all-exceptions.filter';
import { AuthModule } from './auth/auth.module';
import { ConfigModule } from './config/config.module';
import { ENV, type Env } from './config/env';
import { HealthModule } from './health/health.module';
import { MeModule } from './me/me.module';
import { ObjectStorageModule } from './object-storage/object-storage.module';
import { PatientsModule } from './patients/patients.module';
import { RecommendationsModule } from './recommendations/recommendations.module';
import { ReportsModule } from './reports/reports.module';
import { StorageModule } from './storage/storage.module';

@Module({})
export class AppModule {
  static register(env: Env): DynamicModule {
    return {
      module: AppModule,
      imports: [
        ConfigModule.forRoot(env),
        LoggerModule.forRootAsync({
          inject: [ENV],
          useFactory: (config: Env) => ({
            pinoHttp: {
              level: config.LOG_LEVEL,
              genReqId: (req: IncomingMessage) => (req as Request).id ?? randomUUID(),
              // Defence in depth: secrets are redacted even if the serializers below are ever loosened.
              redact: { paths: ['req.headers.authorization', 'req.headers.cookie'], censor: '[redacted]' },
              serializers: {
                // Log the path only: query strings can carry identifiers.
                req: (req: IncomingMessage & { id: string }) => ({
                  id: req.id,
                  method: req.method,
                  url: String(req.url).split('?')[0],
                }),
                res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
              },
              customProps: (req: IncomingMessage) => ({ userId: (req as Request).principal?.sub }),
            },
          }),
        }),
        AuthModule,
        StorageModule.register(env),
        ObjectStorageModule.register(env),
        PatientsModule,
        ReportsModule,
        RecommendationsModule,
        HealthModule,
        MeModule,
      ],
      providers: [{ provide: APP_FILTER, useClass: AllExceptionsFilter }],
    };
  }
}
