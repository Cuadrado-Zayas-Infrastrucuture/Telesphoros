import { createHash } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { loadMigrations, MIGRATIONS_DIR } from '../src/db/migrator';

/**
 * The one place that pins the migration history. It runs without a database.
 *
 * What it guards, and what it leaves to others:
 * - Shape (no gap, no duplicate number, a pair for every number, one name per number): `loadMigrations` throws on all four, so loading the real
 *   directory below IS the check. This spec adds what the loader skips silently: a file in the directory whose name does not match the pattern.
 * - History: the migrations that had shipped when this list was written are pinned by name and checksum (the checksum the migrator records
 *   in `schema_migrations`, so a value here can be compared with a real database). Editing, removing, renaming or renumbering one fails here,
 *   on a fresh checkout, before any database has applied it.
 * - A new migration is NOT in this list and adding one does not touch this file: it must follow the last pinned one and is checked for shape
 *   only. Once it is released, the migrator's own checksum comparison (and the readiness check) protects it on every database that applied it.
 *   Extending the pin is a deliberate act, done in a change of its own, never a side effect of adding a migration.
 *
 * Every other spec that needs the history asks `test/helpers/migration-history.ts`, which derives it from the directory.
 */
const PINNED: ReadonlyArray<readonly [version: string, name: string, checksum: string]> = [
  ['0001', 'core_tables', '5c514b65ef14ca5fb54190f24d2787a1ba02be7b66c0879fb65b338b045da7c8'],
  ['0002', 'row_level_security', '27c4708d7f7d5aaf82615e4debb1f3053e5e376150ed490cc4aa06d024e8fc97'],
  ['0003', 'tenancy', '0e44ba31d14798908e341e9000f1fe439f14795cb513ba455cd4be3c854faf98'],
  ['0004', 'lab_pdf_report_type', '3abd789a49c80ed165fc77204c2fc1b42f0823eb5e25a4e6aaaa741abc21de19'],
  ['0005', 'ledger', 'b356f92f985f8d879cf4d120d1c7ee43144e3188be7f969d0c7fc3ac47bca6a4'],
  ['0006', 'event_notes', '40c7eb53c5f091f3e5a72f8256ade9ca4efd13fd87d0cdd1c832da2bf7f21840'],
  ['0007', 'captures', '802cc3bf27fd0dfb63cb1ba531e9d68176a5876d7ed9137b2dbe6eacc0048fee'],
  ['0008', 'evaluations', '45fd7d6b09fd829e099abc6d7d23422d7f6c2264fc2318278aeb1c7e78ace302'],
  ['0009', 'corrections_and_disputes', 'af90457baa736ce86e0c707b7baf94c7c251aec795e1f026c55fc80d1d6ab1fa'],
  ['0010', 'report_evidence', '0eab4d977a4553396031652d5c0e15c3189482901dd9b3c51a4bb6b724e60f96'],
  ['0011', 'ledger_incidents', '23bc15c063d8479df9e74ee4936a83ffbd3aa339be337e86a65a7c40da3bedfe'],
  ['0012', 'recommendation_report_patient', '028f050a44640ce289bd01e64f9dcd13f34fc4d1f996869dc57162c244cb0027'],
  ['0013', 'validate_recommendation_report_patient', 'cababfa2a30a9f66c76333f8cd02741b49c5a3c89618a33dfbae80e89604fd67'],
  ['0014', 'report_creation_requests', '5c523f99ad7243dd775962f2fa8ed8fed62b17d608223229fd4dfa1d7ff77a55'],
  ['0015', 'upload_attempts', '4390ae25ea3e03d31ade48a6f56f999f8c82dee98f284c7c0dc4fca1e6514012'],
  ['0016', 'security_access_audit', '4cf62724f3d5c912657a8f56c44ff463f035f1f72667201a85546049fb70ee48'],
  ['0017', 'membership', '5fef77ec9163ab6fbbd2a29eff26a1756ca267d80381c80a22560fa8a3debe0c'],
  ['0018', 'security_events', 'ae97da0bced10088d031aef3f617df153c7285276f0dbec546e0855868333476'],
  ['0019', 'tenants_member_admin', '96fb0bb0b84938a766fd32b7c39df11cd0952f0de0acede5c276171af673c8ba'],
  ['0020', 'patient_identifiers_and_link', 'ad4acfe8a8a8b8b37fa601bc3d9cdda4a03b011f2cf21a62c3f011049c85ffb2'],
  ['0021', 'patient_duplicates_and_merge', '6d2f762726d1913c05543f61d225957a86c6c5ff7fd5e84e14e94fe0fed24c2b'],
  ['0022', 'intake_rejected_event', '90e48a0524f333ac31b27f4957e549cd0414f05840d8c5840552b99e4855dd3c'],
  ['0023', 'jobs', '6c1becf063f205fab44c974b7cbf2de88536b2567e9c933e29e7525e67e35e5e'],
  ['0024', 'outbox_consumers', '9d9eeee18b515dc6304a409ffd978d169c5841d0fec8a34a35b151c4cb66ae79'],
  ['0025', 'job_stats_held', '0b894f6388545e85e06753cfc1eff9bfb073277414b67bfdd3c403d9ca241417'],
  ['0026', 'browser_sessions', 'edc5d0a24303260cd240836d66ba8e08336e855415efb7c6b0630a513d67f94e'],
  ['0027', 'browser_session_clocks', 'b554ec9c790edc6ae0ebbc6302a42a218dfe990b1f9e6f81862f9194c236affd'],
  ['0028', 'tenant_capability', 'ba7b1fa34c03334c0f4f0d13bb931153934679472378ee768f16c57fe45367c1'],
  ['0029', 'agentic_synthetic', 'c4624300206a059cc588badd51859b13cac73495c403a390d164b9bf3034deec'],
];

const FILE_NAME = /^(\d{4})_([a-z0-9_]+)\.(up|down)\.sql$/;

describe('migration history', () => {
  it('has only migration files in the directory (the loader skips anything else without a word)', () => {
    const strays = readdirSync(MIGRATIONS_DIR).filter((file) => !FILE_NAME.test(file));
    expect(strays).toEqual([]);
  });

  it('loads: numbered 0001 upward with no gap or repeat, one name per number, an up and a down for each', () => {
    // Throws (and so fails) on a gap, on two names for one number, or on a missing half of a pair.
    const loaded = loadMigrations();
    expect(loaded.map((m) => m.version)).toEqual(loaded.map((_m, index) => String(index + 1).padStart(4, '0')));
  });

  it('keeps every pinned migration exactly as it shipped: same number, name and content', () => {
    const loaded = loadMigrations();
    if (loaded.length < PINNED.length) {
      throw new Error(`Only ${loaded.length} migrations found; ${PINNED.length} had shipped. A shipped migration was removed: restore it and add a new migration instead.`);
    }
    // One line per migration, so a failure names the migration (and the first 16 hex digits of its checksum) that changed.
    const line = (version: string, name: string, checksum: string) => `${version}_${name} ${checksum.slice(0, 16)}`;
    expect(loaded.slice(0, PINNED.length).map((m) => line(m.version, m.name, m.checksum))).toEqual(PINNED.map(([v, n, c]) => line(v, n, c)));
  });

  it('computes the checksum the way the migrator records it (so a pin can be compared with a real database)', () => {
    const [first] = loadMigrations();
    const expected = createHash('sha256').update(first!.upSql).update('\0').update(first!.downSql).digest('hex');
    expect(first!.checksum).toBe(expected);
  });
});
