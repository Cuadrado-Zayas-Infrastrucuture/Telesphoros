import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { Client } from 'pg';
import { createEphemeralDatabase, type EphemeralDatabase } from '../../../backend/test/helpers/database';

// The reused backend fixture also defines an optional Jest-only serialization helper.
// This suite never calls it; these ambient declarations keep its source type-checkable
// without adding Jest to the ai-service runtime or package dependency graph.
declare global {
  function beforeAll(work: () => unknown, timeout?: number): void;
  function afterAll(work: () => unknown, timeout?: number): void;
}

interface OwnedManifest {
  run_id: string;
  uid: number;
  state: string;
  run: string;
  socket: string;
  system_identifier: string;
}

const controlRoot = resolve(import.meta.dirname, '../../../../../p2-postgres-runtime/control');
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Reject ambient, remote, old or non-owned databases before the shared helper creates anything. */
export async function ownedPostgresFixture(): Promise<EphemeralDatabase> {
  const manifestPath = process.env.P2_PG_MANIFEST;
  const adminUrl = process.env.TEST_DATABASE_URL;
  if (!manifestPath || !adminUrl || dirname(manifestPath) !== controlRoot ||
    !uuid.test(manifestPath.split('/').at(-1)?.replace(/\.json$/, '') ?? '')) throw new Error('OWNED_PG_CONFIG_REQUIRED');
  const stat = lstatSync(manifestPath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o600)
    throw new Error('OWNED_PG_MANIFEST_REFUSED');
  const bytes = readFileSync(manifestPath);
  const seal = readFileSync(manifestPath.replace(/\.json$/, '.sha256'), 'utf8').trim();
  if (createHash('sha256').update(bytes).digest('hex') !== seal) throw new Error('OWNED_PG_SEAL_REFUSED');
  const manifest = JSON.parse(bytes.toString('utf8')) as OwnedManifest;
  if (manifest.state !== 'running' || manifest.uid !== process.getuid?.() ||
    manifest.run_id !== manifestPath.split('/').at(-1)?.replace(/\.json$/, '') ||
    !manifest.socket.startsWith('/private/tmp/tp2-') || realpathSync(manifest.socket) !== manifest.socket ||
    (statSync(manifest.socket).mode & 0o777) !== 0o700) throw new Error('OWNED_PG_IDENTITY_REFUSED');
  const url = new URL(adminUrl);
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.hostname !== 'localhost' ||
    url.port !== '54389' || url.username !== 'p2_owner' || url.pathname !== '/postgres' ||
    url.searchParams.get('host') !== manifest.socket || [...url.searchParams.keys()].join(',') !== 'host')
    throw new Error('OWNED_PG_ENDPOINT_REFUSED');
  const client = new Client({ connectionString: adminUrl });
  try {
    await client.connect();
    const { rows } = await client.query<{ data_directory: string; system_identifier: string;
      fsync: string; sync: string; full_page_writes: string; listen: string; version: string;
      tcp_absent: boolean }>(`SELECT current_setting('data_directory') AS data_directory,
        (pg_control_system()).system_identifier::text AS system_identifier,
        current_setting('fsync') AS fsync, current_setting('synchronous_commit') AS sync,
        current_setting('full_page_writes') AS full_page_writes,
        current_setting('listen_addresses') AS listen,
        current_setting('server_version_num') AS version, inet_server_addr() IS NULL AS tcp_absent`);
    const settings = rows[0];
    if (!settings || settings.data_directory !== `${manifest.run}/pgdata` ||
      settings.system_identifier !== manifest.system_identifier || settings.fsync !== 'on' ||
      settings.sync !== 'on' || settings.full_page_writes !== 'on' || settings.listen !== '' ||
      settings.version !== '160014' || !settings.tcp_absent) throw new Error('OWNED_PG_SETTINGS_REFUSED');
  } finally { await client.end(); }
  return createEphemeralDatabase();
}
