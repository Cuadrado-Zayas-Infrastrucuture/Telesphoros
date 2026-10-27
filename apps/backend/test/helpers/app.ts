import { randomBytes, randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
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
import { IssuerCore, PgCapabilityIssueStore } from '../../src/issuer/issuer-core';
import { createIssuerServer, drainServer } from '../../src/issuer/issuer-server';
import type { MembershipAdmin } from '../../src/membership/membership';
import { PgMembershipAdmin } from '../../src/membership/pg-membership-admin';
import { PgTenantAdmin } from '../../src/membership/pg-tenant-admin';
import type { TenantAdmin } from '../../src/membership/membership';
import { InMemorySecurityEvents, SecurityEvents } from '../../src/security-events/security-events';
import { InMemoryMembershipRepository, MembershipRepository } from '../../src/storage/membership.repository';
import { loadEnv } from '../../src/config/env';
import { READINESS_CHECKS, type ReadinessCheck } from '../../src/health/readiness.service';
import { LEDGER_WATCH_CONFIG } from '../../src/ledger/ledger-monitor';
import { ledgerWatchConfig } from '../../src/ledger/ledger.module';
import { createEphemeralDatabase, ownerUrlFor, verifierUrlFor } from './database';
import { PgMembershipMirror, RegisteringMembershipAdmin } from './membership';
import { LAB_READER } from '../../src/lab-reports/evaluations.service';
import { FIXTURES, TEST_KNOWLEDGE } from './lab-pipeline';
import { StandInReportReader } from './stand-in-reader';
// eslint-disable-next-line @typescript-eslint/no-require-imports -- plain CommonJS shared with jest.config.js
const { readerEnginePresent } = require('./reader-engine.cjs') as { readerEnginePresent: () => boolean };
import { TEST_AUDIENCE, TEST_ISSUER, TEST_SECRET } from './env';
import type { TestingModule } from '@nestjs/testing';
import { disposeFixtures, onceFixtureCleanup } from './fixture-cleanup';
import { trackedBuild, trackLive } from './fixture-registry';
import type { EphemeralDatabase } from './database';
import type { RecoveryObjectStorage } from '../../src/object-storage/recovery-object-storage';

export interface TestAppOptions {
  /** Cancelled fixture scopes must not start or return a late application. */
  signal?: AbortSignal;
  recoveryStorage?: RecoveryObjectStorage;
  /** The validated intake in the organization's own scope (M2.2a): no disposable run, any storage the mode allows. The default test app is a disposable local run. */
  organizationIntake?: boolean;
  controllers?: Type<unknown>[];
  readinessChecks?: ReadinessCheck[];
  /** DATABASE_POOL_MAX, the application pool's size (default: the real default). */
  databasePoolMax?: number;
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
  const client = new S3Client({ region: 'us-east-1', endpoint, forcePathStyle: true, credentials: { accessKeyId: 'local-test', secretAccessKey: 'local-test' } });
  try {
    await client.send(new CreateBucketCommand({ Bucket: bucket }));
    // Like the Terraform reports bucket: versioning on, so an uploaded file can be pinned to the exact version that was verified.
    await client.send(new PutBucketVersioningCommand({ Bucket: bucket, VersioningConfiguration: { Status: 'Enabled' } }));
    return { bucket, endpoint };
  } finally {
    client.destroy();
  }
}

/**
 * TEST_REAL_ISSUER=1 (opt-in; unset, nothing here runs): a real issuer HTTP server, the issuer's own core, over the ISSUER login of this test
 * database. The application then reaches it through ISSUER_URL, the same path as production, instead of the null issuer. The verifier is the HMAC
 * one the test tokens are signed for (the deployed issuer verifies Cognito tokens; that verifier is not exercised here). A spec that overrides
 * CapabilityIssuerPort (guard-capability-order) keeps its own issuer: the override wins over this one.
 */
async function startRealIssuer(database: EphemeralDatabase): Promise<{ url: string; stop(): Promise<void> }> {
  const verifier = createVerifier(loadEnv({ NODE_ENV: 'test', JWT_SECRET: TEST_SECRET, JWT_ISSUER: TEST_ISSUER, JWT_AUDIENCE: TEST_AUDIENCE }));
  const store = new PgCapabilityIssueStore({ url: database.issuerUrl, ssl: 'disable' });
  const server = createIssuerServer(new IssuerCore(verifier, store));
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    stop: async () => {
      await drainServer(server, 2_000);
      await store.close();
    },
  };
}

/**
 * Boots the REAL module graph with the REAL app configuration (prefix, versioning, filters, guards).
 * The stores follow the environment, so the SAME e2e tests run against memory, a real PostgreSQL,
 * and an S3-compatible server.
 */
async function buildTestApp(options: TestAppOptions, onClosed: () => void): Promise<NestExpressApplication> {
  let database: EphemeralDatabase | undefined;
  let adminPool: Pool | undefined;
  let moduleRef: TestingModule | undefined;
  let app: NestExpressApplication | undefined;
  let closeApplication: (() => Promise<void>) | undefined;
  let realIssuer: { url: string; stop(): Promise<void> } | undefined;
  const dispose = onceFixtureCleanup(async () => {
    try {
      await disposeFixtures([
        async () => {
          if (closeApplication) await closeApplication();
          else await moduleRef?.close();
        },
        async () => {
          await realIssuer?.stop();
        },
        async () => {
          await adminPool?.end();
        },
        async () => {
          await database?.drop();
        },
      ]);
    } finally {
      onClosed();
    }
  });
  try {
    options.signal?.throwIfAborted();
    database = usingPostgres() && !options.postgresUrl ? await createEphemeralDatabase({ signal: options.signal }) : undefined;
    options.signal?.throwIfAborted();
    // Asked for but impossible here (memory tier, or a spec that brings its own URL): fail loudly rather than run on the null issuer unnoticed.
    if (process.env.TEST_REAL_ISSUER === '1' && !database)
      throw new Error('TEST_REAL_ISSUER=1 needs this app on the ephemeral PostgreSQL tier; refusing to run on the null issuer.');
    realIssuer = database && process.env.TEST_REAL_ISSUER === '1' ? await startRealIssuer(database) : undefined;
    options.signal?.throwIfAborted();
    const runId = options.labReportPipeline || options.recoveryStorage || options.organizationIntake ? undefined : randomUUID();
    const s3 = usingS3() ? await createBucket(runId) : undefined;
    const env = loadEnv({
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      ...(runId ? { LOCAL_STORAGE_RUN_ID: runId } : {}),
      JWT_SECRET: TEST_SECRET,
      JWT_ISSUER: TEST_ISSUER,
      JWT_AUDIENCE: TEST_AUDIENCE,
      STORAGE_DRIVER: database || options.postgresUrl ? 'postgres' : 'memory',
      ...(database || options.postgresUrl ? { DATABASE_URL: options.postgresUrl ?? database!.appUrl } : {}),
      ...(options.databasePoolMax === undefined ? {} : { DATABASE_POOL_MAX: String(options.databasePoolMax) }),
      ...(realIssuer ? { ISSUER_URL: realIssuer.url } : {}),
      ...(options.labReportPipeline ? { LAB_REPORT_PIPELINE: 'enabled' } : {}),
      ...(options.labReportPipeline
        ? {
            LAB_REPORT_FIXTURES_DIR: options.fixturesDir ?? FIXTURES,
            KNOWLEDGE_DIR: options.knowledgeDir ?? TEST_KNOWLEDGE,
            BUILD_VERSION: options.buildVersion ?? 'test-build-1',
            ...(options.maxConcurrentReads ? { LAB_REPORT_MAX_CONCURRENT_READS: String(options.maxConcurrentReads) } : {}),
          }
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

    options.signal?.throwIfAborted();
    const mirror = options.membershipFromTokens ?? true;
    adminPool =
      usingPostgres() || options.postgresUrl ? new Pool({ connectionString: database?.adminUrl ?? options.ownerUrl ?? ownerUrlFor(options.postgresUrl!), max: 2 }) : undefined;
    // Idle connections die when a test drops its database on purpose; that must not become an unhandled 'error' event.
    adminPool?.on('error', () => undefined);
    let builder = Test.createTestingModule({
      imports: [AppModule.register(env, options.recoveryStorage)],
      controllers: options.controllers ?? [],
    });
    if (options.readinessChecks) builder = builder.overrideProvider(READINESS_CHECKS).useValue(options.readinessChecks);
    // The production boot walk waits a random delay of up to a minute (BOOT_PASS_JITTER_MS) so tasks started together do not walk at once.
    // A spec cannot wait that long: the test application walks the ledger as soon as it starts.
    builder = builder.overrideProvider(LEDGER_WATCH_CONFIG).useValue({ ...ledgerWatchConfig(env), bootPassJitterMs: 0 });
    builder = builder.overrideProvider(TokenVerifier).useFactory({
      inject: [MembershipRepository],
      factory: (memberships: MembershipRepository) => {
        const base = options.tokenVerifier ?? createVerifier(env);
        if (!mirror) return base;
        return new MirrorTokenVerifier(base, adminPool ? new PgMembershipMirror(adminPool) : (memberships as InMemoryMembershipRepository));
      },
    });
    const overrides = [...(options.overrides ?? [])];
    // Without the imported reader engine the pipeline reads reports with the test stand-in, unless the spec supplies its own reader.
    if (options.labReportPipeline && !readerEnginePresent() && !overrides.some((o) => o.provide === LAB_READER))
      overrides.push({ provide: LAB_READER, useValue: new StandInReportReader() });
    for (const override of overrides) builder = builder.overrideProvider(override.provide).useValue(override.useValue);
    moduleRef = await builder.compile();
    options.signal?.throwIfAborted();
    app = moduleRef.createNestApplication<NestExpressApplication>();
    closeApplication = app.close.bind(app);
    configureApp(app, { corsOrigins: options.corsOrigins, trustProxyHops: options.trustProxyHops });
    // Listen once on the client's loopback address. On macOS a wildcard IPv6
    // bind can share its port with another process's IPv4 loopback listener,
    // sending supertest's requests to that process instead of this application.
    // Keeping the listener open also avoids per-request start/stop races.
    options.signal?.throwIfAborted();
    await app.listen(0, '127.0.0.1');
    options.signal?.throwIfAborted();

    const readyApp = app;
    const readyPool = adminPool;
    readers.set(
      app,
      adminPool
        ? async () =>
            (await readyPool!.query(`SELECT tenant_id, event_type, outcome, actor_ref, subject_kind, subject_ref, request_id, details FROM security_events ORDER BY seq`)).rows.map(
              (r) =>
                ({
                  tenantId: r.tenant_id,
                  eventType: r.event_type,
                  outcome: r.outcome,
                  actorRef: r.actor_ref,
                  subjectKind: r.subject_kind,
                  subjectRef: r.subject_ref,
                  requestId: r.request_id ?? undefined,
                  details: r.details,
                }) as SeenSecurityEvent,
            )
        : async () =>
            (readyApp.get(SecurityEvents as never) as InMemorySecurityEvents).events.map(
              (e) => Object.fromEntries(Object.entries(e).filter(([key]) => key !== 'at')) as unknown as SeenSecurityEvent,
            ),
    );
    const tenantAdmin: TenantAdmin = adminPool ? new PgTenantAdmin(adminPool) : (app.get(MembershipRepository as never) as unknown as TenantAdmin);
    tenantHandles.set(app, tenantAdmin);
    handles.set(
      app,
      new RegisteringMembershipAdmin(adminPool ? new PgMembershipAdmin(adminPool) : (app.get(MembershipRepository as never) as unknown as MembershipAdmin), tenantAdmin),
    );
    app.close = dispose;
    ephemeralDatabases.set(app, database);
    return app;
  } catch (error) {
    await disposeFixtures([dispose], [error]);
    throw error;
  }
}

/**
 * The application, or the failure that unwound it. If the caller's hook times out while this is pending, Jest abandons the call but not
 * the work: the build keeps going. It is registered so that the end of the test file cancels it and closes what it built, and the
 * application is registered until its owner closes it (see fixture-registry.ts).
 */
export async function createTestApp(options: TestAppOptions = {}): Promise<NestExpressApplication> {
  let forget = () => {};
  const app = await trackedBuild((signal) => buildTestApp({ ...options, signal }, () => forget()), options.signal);
  forget = trackLive(() => app.close());
  return app;
}

const handles = new WeakMap<object, MembershipAdmin>();
const tenantHandles = new WeakMap<object, TenantAdmin>();
const ephemeralDatabases = new WeakMap<object, EphemeralDatabase | undefined>();

/** The issuer login's URL for this app's database, or undefined when the app does not run on PostgreSQL. A scripted issuer uses it to mint real rows. */
export function issuerUrlOf(app: object): string | undefined {
  return ephemeralDatabases.get(app)?.issuerUrl;
}

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
