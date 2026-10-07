import { S3Client } from '@aws-sdk/client-s3';
import { type DynamicModule, Global, Module } from '@nestjs/common';
import type { Env } from '../config/env';
import { InMemoryObjectStorage } from './in-memory-object-storage';
import { ObjectStorage } from './object-storage';
import { S3ObjectStorage } from './s3-object-storage';

@Global()
@Module({})
export class ObjectStorageModule {
  static register(env: Env): DynamicModule {
    if (env.OBJECT_STORAGE_DRIVER === 's3') {
      return {
        module: ObjectStorageModule,
        providers: [
          {
            provide: ObjectStorage,
            useFactory: () =>
              new S3ObjectStorage(
                // Credentials come from the default provider chain (an IAM role in AWS), never from our config.
                new S3Client({ region: env.AWS_REGION, endpoint: env.S3_ENDPOINT, forcePathStyle: env.S3_FORCE_PATH_STYLE }),
                env.REPORTS_BUCKET!,
                env.UPLOAD_URL_TTL_SECONDS,
              ),
          },
        ],
        exports: [ObjectStorage],
      };
    }
    return {
      module: ObjectStorageModule,
      providers: [{ provide: ObjectStorage, useValue: new InMemoryObjectStorage(env.UPLOAD_URL_TTL_SECONDS) }],
      exports: [ObjectStorage],
    };
  }
}
