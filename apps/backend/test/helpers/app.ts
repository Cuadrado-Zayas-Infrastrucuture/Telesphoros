import { randomBytes, randomUUID } from 'node:crypto';
import { CreateBucketCommand, PutBucketVersioningCommand, S3Client } from '@aws-sdk/client-s3';
import { Controller, Get, type Type } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { Pool } from 'pg';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/app.factory';
import { Public } from '../../src/auth/decorators';
import { createVerifier } from '../../src/auth/auth.module';
import { MirrorTokenVerifier } from '../../src/auth/mirror-token-verifier';
import { TokenVerifier } from '../../src/auth/token-verifier';
import type { MembershipAdmin } from '../../src/membership/membership';
import { PgMembershipAdmin } from '../../src/membership/pg-membership-admin';
import { PgTenantAdmin } from '../../src/membership/pg-tenant-admin';
import type { TenantAdmin } from '../../src/membership/membership';
import { InMemorySecurityEvents, SecurityEvents } from '../../src/security-events/security-events';
import { InMemoryMembershipRepository, MembershipRepository } from '../../src/storage/membership.repository';
import { loadEnv } from '../../src/config/env';
import { READINESS_CHECKS, type ReadinessCheck } from '../../src/health/readiness.service';
import { createEphemeralDatabase, ownerUrlFor, verifierUrlFor } from './database';
import { PgMembershipMirror, RegisteringMembershipAdmin } from './membership';
import { FIXTURES, TEST_KNOWLEDGE } from './lab-pipeline';
import { TEST_AUDIENCE, TEST_ISSUER, TEST_SECRET } from './env';
import type { RecoveryObjectStorage } from '../../src/object-storage/recovery-object-storage';

export interface TestAppOptions {
  recoveryStorage?: RecoveryObjectStorage;
  /** Explicit legacy compatibility control, never an owned local intake run. */
  legacyTransport?: boolean;
  controllers?: Type<unknown>[];
  readinessChecks?: ReadinessCheck[];
  /** Force the PostgreSQL store against this application-role URL (managed by the caller). */
  postgresUrl?: string;
  /** The owner (superuser) URL of that same database, when it is not on the default test cluster (a rig that restores into its own server). */
  ownerUrl?: string;
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
  /**
   * Default true: after the real verifier accepts a token, the person's membership is made to match the token's claims, so the many suites
   * that mint tokens keep exercising routes. The membership CHECK still runs on every request. Pass false to manage membership explicitly
   * (membershipOf(app)) and prove that the database, not the token, decides.
   */
  membershipFromTokens?: boolean;
  /** Replace providers by token (e.g. the report reader, to make it slow or fail on purpose). */
  overrides?: Array<{ provide: unknown; useValue: unknown }>;
}

/** True when the e2e suite is running against a real PostgreSQL (TEST_STORAGE=postgres). */
export const usingPostgres = () => process.env.TEST_STORAGE === 'postgres';
/** True when uploads go to an S3-compatible server (TEST_OBJECT_STORAGE=s3 + TEST_S3_ENDPOINT). */
export const usingS3 = () => process.env.TEST_OBJECT_STORAGE === 's3';

async function createBucket(runId?: string) {
  const endpoint = process.env.TEST_S3_ENDPOINT;
  if (!endpoint) throw new Error('TEST_OBJECT_STORAGE=s3 needs TEST_S3_ENDPOINT');
  // Emulators accept any credentials. Real AWS credentials are never used in tests.
  process.env.AWS_ACCESS_KEY_ID ??= 'test';
  process.env.AWS_SECRET_ACCESS_KEY ??= 'test';
  const bucket = runId ? `synthetic-storage-${runId}` : `reports-test-${randomBytes(6).toString('hex')}`;
  const client = new S3Client({ region: 'us-east-1', endpoint, forcePathStyle: true, credentials: {accessKeyId:'local-test',secretAccessKey:'local-test'} });
  await client.send(new CreateBucketCommand({ Bucket: bucket }));
  // Like the Terraform reports bucket: versioning on, so an uploaded file can be pinned to the exact version that was verified.
  await client.send(new PutBucketVersioningCommand({ Bucket: bucket, VersioningConfiguration: { Status: 'Enabled' } }));
  client.destroy();
  return { bucket, endpoint };
}

/**
 * Boots the REAL module graph with the REAL app configuration (prefix, versioning, filters, guards).
 * The stores follow the environment, so the SAME e2e tests run against memory, a real PostgreSQL,
 * and an S3-compatible server.
 */
export async function createTestApp(options: TestAppOptions = {}): Promise<NestExpressApplication> {
  const database = usingPostgres() && !options.postgresUrl ? await createEphemeralDatabase() : undefined;
  const runId = options.labReportPipeline || options.recoveryStorage || options.legacyTransport ? undefined : randomUUID();
  const s3 = usingS3() ? await createBucket(runId) : undefined;
  const env = loadEnv({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    ...(runId ? {LOCAL_STORAGE_RUN_ID:runId} : {}),
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

  const mirror = options.membershipFromTokens ?? true;
  const adminPool = usingPostgres() || options.postgresUrl ? new Pool({ connectionString: database?.adminUrl ?? options.ownerUrl ?? ownerUrlFor(options.postgresUrl!), max: 2 }) : undefined;
  // Idle connections die when a test drops its database on purpose; that must not become an unhandled 'error' event.
  adminPool?.on('error', () => undefined);
  let builder = Test.createTestingModule({
    imports: [AppModule.register(env, options.recoveryStorage)],
    controllers: options.controllers ?? [],
  });
  if (options.readinessChecks) builder = builder.overrideProvider(READINESS_CHECKS).useValue(options.readinessChecks);
  builder = builder.overrideProvider(TokenVerifier).useFactory({
    inject: [MembershipRepository],
    factory: (memberships: MembershipRepository) => {
      const base = options.tokenVerifier ?? createVerifier(env);
      if (!mirror) return base;
      return new MirrorTokenVerifier(base, adminPool ? new PgMembershipMirror(adminPool) : (memberships as InMemoryMembershipRepository));
    },
  });
  for (const override of options.overrides ?? []) builder = builder.overrideProvider(override.provide).useValue(override.useValue);
  const moduleRef = await builder.compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>();
  configureApp(app, { corsOrigins: options.corsOrigins, trustProxyHops: options.trustProxyHops });
  // Listen once on a free port. Otherwise supertest starts/stops the server per request, and two
  // requests built in the same expression race for it.
  await app.listen(0);

  readers.set(
    app,
    adminPool
      ? async () => (await adminPool.query(`SELECT tenant_id, event_type, outcome, actor_ref, subject_kind, subject_ref, request_id, details FROM security_events ORDER BY seq`)).rows
          .map((r) => ({ tenantId: r.tenant_id, eventType: r.event_type, outcome: r.outcome, actorRef: r.actor_ref, subjectKind: r.subject_kind, subjectRef: r.subject_ref, requestId: r.request_id ?? undefined, details: r.details }) as SeenSecurityEvent)
      : async () => (app.get(SecurityEvents as never) as InMemorySecurityEvents).events.map((e) => Object.fromEntries(Object.entries(e).filter(([key]) => key !== 'at')) as unknown as SeenSecurityEvent),
  );
  const tenantAdmin: TenantAdmin = adminPool ? new PgTenantAdmin(adminPool) : (app.get(MembershipRepository as never) as unknown as TenantAdmin);
  tenantHandles.set(app, tenantAdmin);
  handles.set(app, new RegisteringMembershipAdmin(adminPool ? new PgMembershipAdmin(adminPool) : (app.get(MembershipRepository as never) as unknown as MembershipAdmin), tenantAdmin));
  const close = app.close.bind(app);
  app.close = async () => {
    await close();
    await adminPool?.end();
    await database?.drop();
  };
  return app;
}

const handles = new WeakMap<object, MembershipAdmin>();
const tenantHandles = new WeakMap<object, TenantAdmin>();

/** The organization registry handle for an app made by createTestApp. */
export function tenantsOf(app: object): TenantAdmin {
  const handle = tenantHandles.get(app);
  if (!handle) throw new Error('tenantsOf: not an app made by createTestApp');
  return handle;
}

export interface SeenSecurityEvent {
  tenantId: string | null;
  eventType: string;
  outcome: string;
  actorRef: string;
  subjectKind: string;
  subjectRef: string;
  requestId?: string;
  details: Record<string, unknown>;
}
const readers = new WeakMap<object, () => Promise<SeenSecurityEvent[]>>();

/** Every security event the app's store holds, oldest first (read over the owner connection on PostgreSQL, from memory otherwise). */
export function securityEventsOf(app: object): Promise<SeenSecurityEvent[]> {
  const read = readers.get(app);
  if (!read) throw new Error('securityEventsOf: not an app made by createTestApp');
  return read();
}

/** The operator-side handle for an app made by createTestApp: grant, set roles, remove and revoke a person, on the app's own store. */
export function membershipOf(app: object): MembershipAdmin {
  const handle = handles.get(app);
  if (!handle) throw new Error('membershipOf: not an app made by createTestApp');
  return handle;
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
