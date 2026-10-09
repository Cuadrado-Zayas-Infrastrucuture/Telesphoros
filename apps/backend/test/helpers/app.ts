import { randomBytes } from 'node:crypto';
import { CreateBucketCommand, PutBucketVersioningCommand, S3Client } from '@aws-sdk/client-s3';
import { Controller, Get, type Type } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/app.factory';
import { Public } from '../../src/auth/decorators';
import { TokenVerifier } from '../../src/auth/token-verifier';
import { loadEnv } from '../../src/config/env';
import { READINESS_CHECKS, type ReadinessCheck } from '../../src/health/readiness.service';
import { createEphemeralDatabase, verifierUrlFor } from './database';
import { FIXTURES, TEST_KNOWLEDGE } from './lab-pipeline';
import { TEST_AUDIENCE, TEST_ISSUER, TEST_SECRET } from './env';

export interface TestAppOptions {
  controllers?: Type<unknown>[];
  readinessChecks?: ReadinessCheck[];
  /** Force the PostgreSQL store against this application-role URL (managed by the caller). */
  postgresUrl?: string;
  /** Replace the token verifier (e.g. with a CognitoTokenVerifier pointed at the fake identity provider). */
  tokenVerifier?: TokenVerifier;
  /** Browser origins allowed to call the API (CORS). */
  corsOrigins?: string[];
  /** Turn the lab-report pipeline switch on. Needs the PostgreSQL store (the ledger has no in-memory version). */
  labReportPipeline?: boolean;
  /** Where the test-only text runner finds its recorded PDFs (default: the imported hand-off captures). */
  fixturesDir?: string;
  /** The knowledge the pipeline evaluates against (default: the test-only knowledge for the twelve development reports). */
  knowledgeDir?: string;
  buildVersion?: string;
  maxConcurrentReads?: number;
  /**
   * Turn the ledger watch on without the pipeline (it is always on WITH the pipeline: configuration requires it). The verifier login is the
   * test cluster's, for the same database the application URL points at, unless `verifierUrl` says otherwise.
   */
  ledgerWatch?: boolean;
  verifierUrl?: string;
  /** Overrides for LEDGER_STARTUP_BUDGET_MS and LEDGER_FULL_VERIFY_INTERVAL_HOURS (strings, as in a real environment). */
  ledgerSettings?: { LEDGER_STARTUP_BUDGET_MS?: string; LEDGER_FULL_VERIFY_INTERVAL_HOURS?: string };
  /**
   * Rate limiting is OFF in tests unless asked for (one test person makes far more requests than a real one). Pass the limits to turn it on;
   * any left out use the real defaults. `trustProxyHops` is the TRUST_PROXY_HOPS setting.
   */
  rateLimit?: { ip?: number; read?: number; write?: number; expensive?: number };
  trustProxyHops?: number;
  /** Replace providers by token (e.g. the report reader, to make it slow or fail on purpose). */
  overrides?: Array<{ provide: unknown; useValue: unknown }>;
}

/** True when the e2e suite is running against a real PostgreSQL (TEST_STORAGE=postgres). */
export const usingPostgres = () => process.env.TEST_STORAGE === 'postgres';
/** True when uploads go to an S3-compatible server (TEST_OBJECT_STORAGE=s3 + TEST_S3_ENDPOINT). */
export const usingS3 = () => process.env.TEST_OBJECT_STORAGE === 's3';

async function createBucket() {
  const endpoint = process.env.TEST_S3_ENDPOINT;
  if (!endpoint) throw new Error('TEST_OBJECT_STORAGE=s3 needs TEST_S3_ENDPOINT');
  // Emulators accept any credentials. Real AWS credentials are never used in tests.
  process.env.AWS_ACCESS_KEY_ID ??= 'test';
  process.env.AWS_SECRET_ACCESS_KEY ??= 'test';
  const bucket = `test-reports-${randomBytes(5).toString('hex')}`;
  const client = new S3Client({ region: 'us-east-1', endpoint, forcePathStyle: true });
  await client.send(new CreateBucketCommand({ Bucket: bucket }));
  // Like the Terraform reports bucket: versioning on, so an uploaded file can be pinned to the exact version that was verified.
  await client.send(new PutBucketVersioningCommand({ Bucket: bucket, VersioningConfiguration: { Status: 'Enabled' } }));
  return { bucket, endpoint };
}

/**
 * Boots the REAL module graph with the REAL app configuration (prefix, versioning, filters, guards).
 * The stores follow the environment, so the SAME e2e tests run against memory, a real PostgreSQL,
 * and an S3-compatible server.
 */
export async function createTestApp(options: TestAppOptions = {}): Promise<NestExpressApplication> {
  const database = usingPostgres() && !options.postgresUrl ? await createEphemeralDatabase() : undefined;
  const s3 = usingS3() ? await createBucket() : undefined;
  const env = loadEnv({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    JWT_SECRET: TEST_SECRET,
    JWT_ISSUER: TEST_ISSUER,
    JWT_AUDIENCE: TEST_AUDIENCE,
    STORAGE_DRIVER: database || options.postgresUrl ? 'postgres' : 'memory',
    ...(database || options.postgresUrl ? { DATABASE_URL: options.postgresUrl ?? database!.appUrl } : {}),
    ...(options.labReportPipeline ? { LAB_REPORT_PIPELINE: 'enabled' } : {}),
    ...(options.labReportPipeline
      ? { LAB_REPORT_FIXTURES_DIR: options.fixturesDir ?? FIXTURES, KNOWLEDGE_DIR: options.knowledgeDir ?? TEST_KNOWLEDGE, BUILD_VERSION: options.buildVersion ?? 'test-build-1', ...(options.maxConcurrentReads ? { LAB_REPORT_MAX_CONCURRENT_READS: String(options.maxConcurrentReads) } : {}) }
      : {}),
    ...(options.labReportPipeline || options.ledgerWatch
      ? { LEDGER_VERIFIER_DATABASE_URL: options.verifierUrl ?? (database ? database.verifierUrl : verifierUrlFor(options.postgresUrl!)), ...options.ledgerSettings }
      : {}),
    RATE_LIMIT_ENABLED: options.rateLimit ? 'true' : 'false',
    ...(options.rateLimit?.ip === undefined ? {} : { RATE_LIMIT_IP_PER_MINUTE: String(options.rateLimit.ip) }),
    ...(options.rateLimit?.read === undefined ? {} : { RATE_LIMIT_READ_PER_MINUTE: String(options.rateLimit.read) }),
    ...(options.rateLimit?.write === undefined ? {} : { RATE_LIMIT_WRITE_PER_MINUTE: String(options.rateLimit.write) }),
    ...(options.rateLimit?.expensive === undefined ? {} : { RATE_LIMIT_EXPENSIVE_PER_MINUTE: String(options.rateLimit.expensive) }),
    ...(options.trustProxyHops === undefined ? {} : { TRUST_PROXY_HOPS: String(options.trustProxyHops) }),
    OBJECT_STORAGE_DRIVER: s3 ? 's3' : 'memory',
    ...(s3 ? { REPORTS_BUCKET: s3.bucket, S3_ENDPOINT: s3.endpoint, S3_FORCE_PATH_STYLE: 'true', AWS_REGION: 'us-east-1' } : {}),
  });

  let builder = Test.createTestingModule({
    imports: [AppModule.register(env)],
    controllers: options.controllers ?? [],
  });
  if (options.readinessChecks) builder = builder.overrideProvider(READINESS_CHECKS).useValue(options.readinessChecks);
  if (options.tokenVerifier) builder = builder.overrideProvider(TokenVerifier).useValue(options.tokenVerifier);
  for (const override of options.overrides ?? []) builder = builder.overrideProvider(override.provide).useValue(override.useValue);
  const moduleRef = await builder.compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>();
  configureApp(app, { corsOrigins: options.corsOrigins, trustProxyHops: options.trustProxyHops });
  // Listen once on a free port. Otherwise supertest starts/stops the server per request, and two
  // requests built in the same expression race for it.
  await app.listen(0);

  const close = app.close.bind(app);
  app.close = async () => {
    await close();
    await database?.drop();
  };
  return app;
}

/** Test-only routes that misbehave on purpose, to prove nothing internal leaks. */
@Controller('test-faults')
export class FaultsController {
  @Public()
  @Get('crash')
  crash() {
    throw new Error('db password=hunter2 at /srv/app/secret-file.ts:42');
  }

  @Public()
  @Get('type-error')
  typeError() {
    return (undefined as unknown as { x: { y: string } }).x.y;
  }
}
