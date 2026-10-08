import { S3Client } from '@aws-sdk/client-s3';
import { Client } from 'pg';
import { createBackup } from './backup';
import { generateKeyFile } from './backup-crypto';
import { MIGRATIONS_DIR, migrateDown, migrateUp, migrationStatus } from './migrator';
import { restoreAndVerify } from './restore';

const USAGE = `Usage: node dist/db/cli.js <command>

  migrate up                    apply pending migrations          (DATABASE_MIGRATOR_URL: the table owner)
  migrate down [steps]          revert the last N (default 1)     (DATABASE_MIGRATOR_URL)
  migrate status                show applied and pending          (DATABASE_MIGRATOR_URL)

  keygen  --out FILE            create a new random backup key (64 hex characters, owner-only; never overwrites).
                                KEEP COPIES OFFLINE: without this key no backup made with it can ever be restored.

  backup  --dest DIR --key-file FILE [--upload s3://bucket/prefix] [--kms-key-id ID]
                                consistent, encrypted and signed backup (DATABASE_ADMIN_URL: superuser or BYPASSRLS)
          --dest DIR            without --key-file the backup is NOT encrypted: development only
  restore --from DIR [--key-file FILE | --passphrase-file FILE] [--keep] [--target-db NAME]
                                restore into a THROWAWAY database and verify it; exit 1 if anything is off
                                (--key-file: format 2 backups, signature and every chunk checked;
                                 --passphrase-file: old format 1 backups only)  (DATABASE_ADMIN_URL on the target server)
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

async function main(argv: string[]) {
  const [command, sub, ...rest] = argv;

  if (command === 'migrate') {
    const client = new Client({ connectionString: required('DATABASE_MIGRATOR_URL') });
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
    let upload;
    if (uri) {
      const match = /^s3:\/\/([^/]+)\/?(.*)$/.exec(uri);
      if (!match) throw new Error('--upload must look like s3://bucket/prefix');
      upload = {
        client: new S3Client({
          region: process.env.AWS_REGION ?? 'us-east-2',
          endpoint: process.env.S3_ENDPOINT,
          forcePathStyle: process.env.S3_FORCE_PATH_STYLE === 'true',
        }),
        bucket: match[1]!,
        prefix: match[2]!,
        kmsKeyId: f.text('kms-key-id'),
      };
    }
    const { dir, manifest } = await createBackup({
      adminUrl: required('DATABASE_ADMIN_URL'),
      destDir: dest,
      keyFile: f.text('key-file'),
      upload,
    });
    const rows = Object.values(manifest.tables).reduce((sum, t) => sum + t.rows, 0);
    out(`backup written: ${dir}`);
    out(`  ${Object.keys(manifest.tables).length} tables, ${rows} rows, migrations ${manifest.migrations.join(', ') || '(none)'}`);
    out(`  ${manifest.dump.file}  ${manifest.dump.bytes} bytes  sha256 ${manifest.dump.sha256}${manifest.dump.encrypted ? '  (encrypted, signed manifest)' : '  (NOT encrypted)'}`);
    if (uri) out(`  uploaded to ${uri}`);
    return;
  }

  if (command === 'restore') {
    const f = flags([sub, ...rest].filter((a): a is string => a !== undefined));
    const from = f.text('from');
    if (!from) throw new Error('--from is required');
    const report = await restoreAndVerify({
      adminUrl: required('DATABASE_ADMIN_URL'),
      backupDir: from,
      keyFile: f.text('key-file'),
      passphraseFile: f.text('passphrase-file'),
      keep: f.bool('keep'),
      targetDatabase: f.text('target-db'),
    });
    for (const check of report.checks) out(`${check.ok ? 'PASS' : 'FAIL'}  ${check.name}: ${check.detail}`);
    out(report.ok ? `RESTORE VERIFIED (${report.kept ? `kept as ${report.database}` : 'throwaway database dropped'})` : 'RESTORE FAILED');
    process.exitCode = report.ok ? 0 : 1;
    return;
  }

  throw new Error(USAGE);
}

main(process.argv.slice(2)).catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
