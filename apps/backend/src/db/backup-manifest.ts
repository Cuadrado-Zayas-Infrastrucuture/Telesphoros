import { z } from 'zod';
import { ENCRYPTION_SCHEME } from './backup-crypto';

/**
 * The manifest is read back from storage that may not be ours (a second provider's bucket), so it is validated, not
 * trusted: every field has a type and a shape, and the dump's file name cannot point outside the backup directory.
 * Format 1 (passphrase, unauthenticated) is still READ so old backups stay restorable; format 2 is what is written.
 */

export interface TableFacts {
  rows: number;
  rlsEnabled: boolean;
  rlsForced: boolean;
  policies: number;
}

const count = z.number().int().nonnegative();
const hex = (digits: number) => z.string().regex(new RegExp(`^[0-9a-f]{${digits}}$`));

const tableFacts = z.object({ rows: count, rlsEnabled: z.boolean(), rlsForced: z.boolean(), policies: count }).strict();

// A plain file name: no separators, no "..", nothing that escapes the backup directory.
const fileName = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/).refine((name) => !name.includes('..'));

/** Who owns and who may do what (privilege-facts.ts). Optional: backups made before they were recorded do not have it. */
const privileges = z
  .object({
    roles: z.array(z.string().max(128)).max(200),
    ownership: z.array(z.string().max(512)).max(20_000),
    grants: z.array(z.string().max(512)).max(50_000),
  })
  .strict();

const facts = {
  createdAt: z.string().min(1).max(64),
  serverVersion: z.string().min(1).max(64),
  database: z.string().min(1).max(128),
  migrations: z.array(z.string().max(128)).max(10_000),
  /** Counts include soft-deleted rows: they are part of the audit trail and must survive a restore. */
  tables: z.record(z.string().max(128), tableFacts),
  schema: z.object({ constraints: count, indexes: count, triggers: count }).strict(),
  privileges: privileges.optional(),
};

const manifestV1 = z
  .object({
    formatVersion: z.literal(1),
    ...facts,
    dump: z.object({ file: fileName, bytes: count, sha256: hex(64), plaintextSha256: hex(64), encrypted: z.boolean() }).strict(),
  })
  .strict();

const manifestV2 = z
  .object({
    formatVersion: z.literal(2),
    ...facts,
    dump: z
      .object({
        file: fileName,
        bytes: count,
        sha256: hex(64),
        plaintextSha256: hex(64),
        encrypted: z.literal(true),
        encryption: z
          .object({
            scheme: z.literal(ENCRYPTION_SCHEME),
            keyId: hex(16),
            salt: hex(32),
            chunkSize: z.number().int().min(64).max(2 ** 26),
          })
          .strict(),
      })
      .strict(),
    /** HMAC-SHA-256 over every other field, under a key only the key file holds (see backup-crypto.ts). */
    mac: hex(64),
  })
  .strict();

export type BackupManifestV1 = z.infer<typeof manifestV1>;
export type BackupManifestV2 = z.infer<typeof manifestV2>;
export type BackupManifest = BackupManifestV1 | BackupManifestV2;

/** Thrown for a manifest that is not valid JSON or does not have the expected shape. Never echoes the manifest's contents. */
export class ManifestError extends Error {
  constructor(detail: string) {
    super(`The backup manifest is not valid: ${detail}`);
    this.name = 'ManifestError';
  }
}

export function parseManifest(text: string): BackupManifest {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new ManifestError('it is not JSON.');
  }
  const version = (raw as { formatVersion?: unknown } | null)?.formatVersion;
  if (version !== 1 && version !== 2) throw new ManifestError('unknown format version.');
  const parsed = (version === 1 ? manifestV1 : manifestV2).safeParse(raw);
  if (!parsed.success) {
    const where = [...new Set(parsed.error.issues.map((issue) => issue.path.map(String).join('.') || '(root)'))].slice(0, 5).join(', ');
    throw new ManifestError(`check ${where}.`);
  }
  return parsed.data;
}
