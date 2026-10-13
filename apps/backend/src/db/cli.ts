import { readFileSync } from 'node:fs';
import { Client } from 'pg';
import { InvitationDigest } from '../members/invitation-digest';
import { MEMBERSHIP_USAGE, runMembership } from '../membership/membership-cli';
import { PgInvitationAdmin } from '../membership/pg-invitation-admin';
import { PgTenantAdmin } from '../membership/pg-tenant-admin';
import { runInvite, runTenant, TENANT_USAGE } from '../membership/tenant-cli';
import { PgMembershipAdmin } from '../membership/pg-membership-admin';
import { runSecurityEvents, SECURITY_EVENTS_USAGE } from '../security-events/security-events-cli';
import { createBackup } from './backup';
import { generateKeyFile, readKeyFile } from './backup-crypto';
import { parseManifest } from './backup-manifest';
import { MIGRATIONS_DIR, migrateDown, migrateUp, migrationStatus } from './migrator';
import {
  createOffsiteClient,
  hasCredentials,
  loadCredentials,
  loadOffsiteSettings,
  type LockMode,
  OffsiteError,
  parseRemote,
  type Role,
  type UploadTarget,
  uploadBackup,
} from './offsite';
import { type Finding, runBackupCheck } from './offsite-check';
import { provisionLogins } from './provision-logins';
import { secretsManagerStore } from './provision-secrets';
import { restoreAndVerify } from './restore';
import { restoreFromRemote } from './restore-remote';
import { pgClientConfig, tlsFromEnv } from './tls';

const USAGE = `Usage: node dist/db/cli.js <command>

  migrate up                    apply pending migrations          (DATABASE_MIGRATOR_URL: the table owner)
  migrate down [steps]          revert the last N (default 1)     (DATABASE_MIGRATOR_URL)
  migrate status                show applied and pending          (DATABASE_MIGRATOR_URL)

  provision-logins [--rotate] [--require-migrated]
                                create the application, ledger-verifier and migrator logins with generated passwords and store their
                                connection strings in Secrets Manager (a one-off task; no password is ever printed or logged).
                                Run it before "migrate up", and again after it with --require-migrated to check the group privileges.
                                Env: PROVISION_ADMIN_USER, PROVISION_ADMIN_PASSWORD (the RDS-managed administrator), DATABASE_HOST,
                                [DATABASE_PORT=5432] [DATABASE_NAME=telesphoros], PROVISION_SECRET_APP / _VERIFIER / _MIGRATOR (secret ids).

${MEMBERSHIP_USAGE}
${TENANT_USAGE}
${SECURITY_EVENTS_USAGE}
  keygen  --out FILE            create a new random backup key (64 hex characters, owner-only; never overwrites).
                                KEEP COPIES OFFLINE: without this key no backup made with it can ever be restored.

  backup  --dest DIR --key-file FILE [--upload s3://bucket/prefix] [--retain-days N] [--lock-mode GOVERNANCE|COMPLIANCE]
          [--remove-local] [--kms-key-id ID]
                                consistent, encrypted and signed backup (DATABASE_ADMIN_URL: superuser or BYPASSRLS).
                                --upload copies it to a second provider (BACKUP_S3_UPLOAD_* credentials, Object Lock
                                on every object). Without --key-file the backup is NOT encrypted: development only.
  upload  --from DIR --to s3://bucket/prefix --key-file FILE [--retain-days N] [--lock-mode M] [--remove-local]
                                retry the off-site copy of a backup that is already on disk
  backup-check --remote s3://bucket/prefix --key-file FILE [--max-age-hours N] [--skip-canary] [--canary-retain-days N]
                                prove the off-site set-up is right (key, bucket, Object Lock, separate upload and read
                                keys, a canary round trip, newest backup authentic and recent); exit 1 on any FAIL
                                (BACKUP_S3_UPLOAD_*, BACKUP_S3_READ_*, optional BACKUP_S3_ADMIN_*)
  restore --from DIR|s3://bucket/prefix[/backup-TIME] [--latest] [--key-file FILE | --passphrase-file FILE]
          [--keep] [--target-db NAME]
                                restore into a THROWAWAY database and verify it; exit 1 if anything is off
                                (--key-file: format 2 backups, signature and every chunk checked;
                                 --passphrase-file: old format 1 backups only; s3:// uses BACKUP_S3_READ_*)
                                                                  (DATABASE_ADMIN_URL on the target server)

Off-site settings (all BACKUP_S3_*): ENDPOINT, REGION, FORCE_PATH_STYLE, SSE (default none), KMS_KEY_ID;
credentials per role: BACKUP_S3_<UPLOAD|READ|ADMIN>_ACCESS_KEY_ID / _SECRET_ACCESS_KEY (or the same names + _FILE).
The AWS credentials are never used for the off-site copy.
`;

const out = (text: string) => process.stdout.write(`${text}\n`);

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

function flags(args: string[]) {
  const values = new Map<string, string | true>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (!arg.startsWith('--')) throw new Error(`Unexpected argument: ${arg}`);
    const next = args[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      values.set(arg.slice(2), next);
      i++;
    } else {
      values.set(arg.slice(2), true);
    }
  }
  const text = (name: string) => {
    const v = values.get(name);
    return typeof v === 'string' ? v : undefined;
  };
  return { text, bool: (name: string) => values.get(name) === true };
}

function offsiteOverrides(f: ReturnType<typeof flags>) {
  const days = f.text('retain-days');
  const kms = f.text('kms-key-id');
  return {
    lockMode: f.text('lock-mode') as LockMode | undefined,
    retainDays: days === undefined ? undefined : Number(days),
    ...(kms ? { sse: 'aws:kms' as const, kmsKeyId: kms } : {}),
  };
}

function uploadTarget(remote: string, f: ReturnType<typeof flags>): UploadTarget {
  const settings = loadOffsiteSettings(process.env, offsiteOverrides(f));
  const location = parseRemote(remote);
  return {
    client: createOffsiteClient(settings, loadCredentials('upload')),
    bucket: location.bucket,
    prefix: location.prefix,
    sse: settings.sse,
    kmsKeyId: settings.kmsKeyId,
    lockMode: settings.lockMode,
    retainDays: settings.retainDays,
  };
}

function printUpload(upload: { keys: string[]; warnings: string[]; etagVerified: boolean }, remote: string) {
  out(`  uploaded ${upload.keys.length} objects to ${remote} (Object Lock on each${upload.etagVerified ? '' : '; the provider\u2019s ETag is not an MD5, so only Content-MD5 was checked'})`);
  for (const warning of upload.warnings) out(`  WARNING: ${warning}`);
}

function printFindings(findings: Finding[]) {
  for (const finding of findings) out(`${finding.status.padEnd(4)}  ${finding.name}: ${finding.detail}`);
  const failed = findings.filter((f) => f.status === 'FAIL').length;
  const warned = findings.filter((f) => f.status === 'WARN').length;
  out(failed ? `BACKUP CHECK FAILED (${failed} failing${warned ? `, ${warned} warning` : ''})` : `BACKUP CHECK PASSED${warned ? ` (${warned} warning)` : ''}`);
  return failed === 0;
}

async function main(argv: string[]) {
  const [command, sub, ...rest] = argv;

  if (command === 'migrate') {
    const client = new Client(pgClientConfig(required('DATABASE_MIGRATOR_URL')));
    await client.connect();
    try {
      if (sub === 'up') {
        const applied = await migrateUp(client);
        out(applied.length ? `applied: ${applied.join(', ')}` : 'nothing to apply');
      } else if (sub === 'down') {
        const steps = rest[0] ? Number(rest[0]) : 1;
        if (!Number.isInteger(steps) || steps < 1) throw new Error('steps must be a positive integer');
        const reverted = await migrateDown(client, steps);
        out(reverted.length ? `reverted: ${reverted.join(', ')}` : 'nothing to revert');
      } else if (sub === 'status') {
        const { applied, pending } = await migrationStatus(client);
        out(`migrations dir: ${MIGRATIONS_DIR}`);
        out(`applied: ${applied.map((m) => m.version).join(', ') || '(none)'}`);
        out(`pending: ${pending.map((m) => m.version).join(', ') || '(none)'}`);
      } else {
        throw new Error(USAGE);
      }
    } finally {
      await client.end();
    }
    return;
  }

  if (command === 'membership') {
    const client = new Client(pgClientConfig(required('DATABASE_MIGRATOR_URL')));
    await client.connect();
    try {
      process.exitCode = await runMembership(new PgMembershipAdmin(client), [sub, ...rest].filter((a): a is string => a !== undefined), out);
    } finally {
      await client.end();
    }
    return;
  }

  if (command === 'tenant' || command === 'invite') {
    const client = new Client(pgClientConfig(required('DATABASE_MIGRATOR_URL')));
    await client.connect();
    try {
      const rest2 = [sub, ...rest].filter((a): a is string => a !== undefined);
      if (command === 'tenant') {
        process.exitCode = await runTenant(new PgTenantAdmin(client), rest2, out);
      } else {
        const key = process.env.INVITATION_DIGEST_KEY;
        if (!key && process.env.NODE_ENV === 'production') throw new Error('INVITATION_DIGEST_KEY is not set');
        process.exitCode = await runInvite(new PgInvitationAdmin(client, new InvitationDigest(key)), rest2, out);
      }
    } finally {
      await client.end();
    }
    return;
  }

  if (command === 'security-events') {
    const client = new Client(pgClientConfig(required('DATABASE_AUDITOR_URL')));
    await client.connect();
    try {
      process.exitCode = await runSecurityEvents(client, [sub, ...rest].filter((a): a is string => a !== undefined), out);
    } finally {
      await client.end();
    }
    return;
  }

  if (command === 'provision-logins') {
    const f = flags([sub, ...rest].filter((a): a is string => a !== undefined));
    const host = required('DATABASE_HOST');
    const port = Number(process.env.DATABASE_PORT || 5432);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('DATABASE_PORT must be a port number');
    const database = process.env.DATABASE_NAME || 'telesphoros';
    const admin = new URL('postgres://placeholder');
    admin.username = required('PROVISION_ADMIN_USER');
    admin.password = required('PROVISION_ADMIN_PASSWORD');
    admin.hostname = host;
    admin.port = String(port);
    admin.pathname = `/${database}`;
    const report = await provisionLogins({
      adminUrl: admin.toString(),
      tls: tlsFromEnv(),
      target: { host, port },
      secrets: { app: required('PROVISION_SECRET_APP'), verifier: required('PROVISION_SECRET_VERIFIER'), migrator: required('PROVISION_SECRET_MIGRATOR') },
      store: secretsManagerStore(),
      rotate: f.bool('rotate'),
      requireMigrated: f.bool('require-migrated'),
    });
    for (const login of report.logins) out(`${login.action.padEnd(9)} ${login.kind} login (${login.name})`);
    for (const check of report.checks) out(`${check.skipped ? 'SKIP' : check.ok ? 'PASS' : 'FAIL'}  ${check.name}: ${check.detail}`);
    out(report.ok ? 'LOGINS READY' : 'LOGINS NOT READY');
    process.exitCode = report.ok ? 0 : 1;
    return;
  }

  if (command === 'keygen') {
    const f = flags([sub, ...rest].filter((a): a is string => a !== undefined));
    const file = f.text('out');
    if (!file) throw new Error('--out is required');
    const { keyId } = await generateKeyFile(file);
    out(`key written: ${file}  (key id ${keyId})`);
    out('Store copies of this file OFFLINE with two different people. It is never printed again, and it is not in any backup.');
    return;
  }

  if (command === 'backup') {
    const f = flags([sub, ...rest].filter((a): a is string => a !== undefined));
    if (f.text('passphrase-file') !== undefined) {
      throw new Error('--passphrase-file is no longer used for new backups. Create a key with `keygen --out FILE` and pass --key-file.');
    }
    const dest = f.text('dest');
    if (!dest) throw new Error('--dest is required');
    const uri = f.text('upload');
    const { dir, manifest, upload, localRemoved } = await createBackup({
      adminUrl: required('DATABASE_ADMIN_URL'),
      destDir: dest,
      keyFile: f.text('key-file'),
      upload: uri ? uploadTarget(uri, f) : undefined,
      removeLocalAfterUpload: f.bool('remove-local'),
    });
    const rows = Object.values(manifest.tables).reduce((sum, t) => sum + t.rows, 0);
    out(`backup written: ${dir}${localRemoved ? '  (local copy removed after the verified upload)' : ''}`);
    out(`  ${Object.keys(manifest.tables).length} tables, ${rows} rows, migrations ${manifest.migrations.join(', ') || '(none)'}`);
    out(`  ${manifest.dump.file}  ${manifest.dump.bytes} bytes  sha256 ${manifest.dump.sha256}${manifest.dump.encrypted ? '  (encrypted, signed manifest)' : '  (NOT encrypted)'}`);
    if (upload && uri) printUpload(upload, uri);
    return;
  }

  if (command === 'upload') {
    const f = flags([sub, ...rest].filter((a): a is string => a !== undefined));
    const from = f.text('from');
    const to = f.text('to');
    const keyFile = f.text('key-file');
    if (!from || !to || !keyFile) throw new Error('--from, --to and --key-file are required');
    const manifest = parseManifest(readFileSync(`${from}/manifest.json`, 'utf8'));
    const upload = await uploadBackup(from.replace(/\/$/, ''), manifest, uploadTarget(to, f), await readKeyFile(keyFile));
    out(`uploaded ${from}`);
    printUpload(upload, to);
    return;
  }

  if (command === 'backup-check') {
    const f = flags([sub, ...rest].filter((a): a is string => a !== undefined));
    const remote = f.text('remote');
    const keyFile = f.text('key-file');
    if (!remote || !keyFile) throw new Error('--remote and --key-file are required');
    const settings = loadOffsiteSettings(process.env, offsiteOverrides(f));
    const location = parseRemote(remote);
    const days = f.text('canary-retain-days');
    const maxAge = f.text('max-age-hours');
    const skipCanary = f.bool('skip-canary');
    const client = (role: Role) => createOffsiteClient(settings, loadCredentials(role));
    const findings = await runBackupCheck({
      keyFile,
      bucket: location.bucket,
      prefix: location.prefix,
      settings,
      clients: { upload: skipCanary && !hasCredentials('upload') ? client('read') : client('upload'), read: client('read'), ...(hasCredentials('admin') ? { admin: client('admin') } : {}) },
      maxAgeHours: maxAge === undefined ? undefined : Number(maxAge),
      skipCanary,
      canaryRetainDays: days === undefined ? undefined : Number(days),
    });
    process.exitCode = printFindings(findings) ? 0 : 1;
    return;
  }

  if (command === 'restore') {
    const f = flags([sub, ...rest].filter((a): a is string => a !== undefined));
    const from = f.text('from');
    if (!from) throw new Error('--from is required');
    const common = {
      adminUrl: required('DATABASE_ADMIN_URL'),
      keyFile: f.text('key-file'),
      passphraseFile: f.text('passphrase-file'),
      keep: f.bool('keep'),
      targetDatabase: f.text('target-db'),
    };
    const report = from.startsWith('s3://')
      ? await restoreFromRemote({ ...common, client: createOffsiteClient(loadOffsiteSettings(), loadCredentials('read')), location: parseRemote(from), latest: f.bool('latest') })
      : await restoreAndVerify({ ...common, backupDir: from });
    for (const check of report.checks) out(`${check.ok ? 'PASS' : 'FAIL'}  ${check.name}: ${check.detail}`);
    out(report.ok ? `RESTORE VERIFIED (${report.kept ? `kept as ${report.database}` : 'throwaway database dropped'})` : 'RESTORE FAILED');
    process.exitCode = report.ok ? 0 : 1;
    return;
  }

  throw new Error(USAGE);
}

main(process.argv.slice(2)).catch((error: unknown) => {
  // Configuration and protocol errors carry fixed, key-free messages; anything else is reported by name only.
  const message = error instanceof Error && (error instanceof OffsiteError || !('$metadata' in error)) ? error.message : `${(error as { name?: string }).name ?? 'Error'} (the provider refused or failed the request)`;
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
