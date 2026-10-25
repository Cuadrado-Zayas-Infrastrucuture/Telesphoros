import { createHash, randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { MAX_REPORT_BYTES } from '@telesphoros/shared-types';
import { decryptFile, encryptFile, manifestMac, stableStringify, verifyManifestMac } from './backup-crypto';
import type { BackupManifestV2 } from './backup-manifest';
import { makeTempDir } from './cleanup';

export const CATALOGUE_MAX_BYTES = 16 * 1024 ** 2;
export const MAX_REFERENCES = 10_000;
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const hash = z.string().regex(/^[0-9a-f]{64}$/);
const bounded = z.string().min(1).max(1024);
const date = z.string().datetime({ offset: true });
export const generationSchema = z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/);

export type EvidenceCode = 'schema' | 'authentication' | 'binding' | 'inventory' | 'missing' | 'integrity' | 'policy' | 'ambiguous' | 'limit' | 'storage';
/** Fixed codes/messages only; never echoes an untrusted field, provider error, path or identifier. */
export class EvidenceError extends Error {
  constructor(readonly code: EvidenceCode) {
    super('Evidence catalogue refused: ' + code + '.');
    this.name = 'EvidenceError';
  }
}
export class IncompleteEvidenceListingError extends EvidenceError {
  constructor(readonly reason: 'cursor' | 'page-limit' | 'timeout' | 'no-progress') {
    super('limit');
    this.name = 'IncompleteEvidenceListingError';
  }
}
/** Per-object mismatch, distinct from exhaustion of the aggregate resource budget. */
export class EvidenceObjectTooLargeError extends EvidenceError {
  constructor() {
    super('integrity');
    this.name = 'EvidenceObjectTooLargeError';
  }
}

export const bindingSchema = z
  .object({
    manifestSha256: hash,
    archiveSha256: hash,
    plaintextSha256: hash,
    schemaSha256: hash,
    migrations: z.array(z.string().max(128)).max(10_000),
    createdAt: date,
  })
  .strict();
export const policySchema = z
  .object({
    mode: z.literal('COMPLIANCE'),
    retainUntil: date,
    encryption: z.enum(['AES256', 'aws:kms']),
    keyId: bounded.nullable(),
  })
  .strict()
  .refine((p) => (p.encryption === 'AES256' ? p.keyId === null : p.keyId !== null));
export type EvidencePolicy = z.infer<typeof policySchema>;
export type EvidenceBinding = z.infer<typeof bindingSchema>;

export const referenceSchema = z
  .object({
    tenantId: z.string().min(1).max(128),
    reportId: z.string().uuid(),
    captureId: z.string().uuid().nullable(),
    kind: z.enum(['lab-pdf', 'vcf', 'structured', 'text']),
    key: bounded,
    dbVersion: bounded.nullable(),
    sha256: hash,
    sizeBytes: count.min(1).max(MAX_REPORT_BYTES).nullable(),
    contentType: bounded,
    scalars: count.max(100_000).nullable(),
    runner: z.enum(['fake', 'poppler']).nullable(),
    popplerVersion: bounded.nullable(),
  })
  .strict()
  .superRefine((r, ctx) => {
    const text = r.kind === 'text';
    if (
      text
        ? r.captureId === null || r.scalars === null || r.runner === null || r.popplerVersion === null || r.sizeBytes !== null || r.dbVersion !== null
        : r.captureId !== null || r.scalars !== null || r.runner !== null || r.popplerVersion !== null || r.sizeBytes === null
    ) {
      ctx.addIssue({ code: 'custom', message: 'Invalid reference shape.' });
    }
    if (r.kind === 'lab-pdf' && (!r.dbVersion || r.dbVersion === 'null')) ctx.addIssue({ code: 'custom', message: 'PDF requires a real pin.' });
  });
export type EvidenceReference = z.infer<typeof referenceSchema>;
export const resolvedSchema = z.object({ reference: referenceSchema, observedVersion: bounded, bytes: count, sourceId: hash }).strict();
export type ResolvedEvidence = z.infer<typeof resolvedSchema>;
const sources = z.array(resolvedSchema).max(MAX_REFERENCES);
const common = {
  generation: generationSchema,
  producedAt: date,
  binding: bindingSchema,
  policy: policySchema,
  sourceBucket: bounded,
  destinationBucket: bounded,
  destinationPrefix: bounded,
  uncompletedRegistrations: count,
  orphanTextObjects: count,
  sources,
};
export const checkpointSchema = z
  .object({ domain: z.literal('telesphoros-evidence/checkpoint/1'), ...common })
  .strict()
  .superRefine((c, ctx) => {
    try {
      validateSources(c.sources, c.sourceBucket);
    } catch {
      ctx.addIssue({ code: 'custom', message: 'Invalid source membership.' });
    }
  });
export const catalogueSchema = z
  .object({
    domain: z.literal('telesphoros-evidence/catalogue/1'),
    ...common,
    mappings: z.array(z.object({ sourceId: hash, destinationVersion: bounded, mode: z.enum(['translated', 'native']) }).strict()).max(MAX_REFERENCES),
  })
  .strict()
  .superRefine((c, ctx) => {
    const expected = new Set(c.sources.map((s) => s.sourceId));
    try {
      validateSources(c.sources, c.sourceBucket);
    } catch {
      ctx.addIssue({ code: 'custom', message: 'Invalid source membership.' });
    }
    if (
      c.mappings.length !== expected.size ||
      new Set(c.mappings.map((m) => m.sourceId)).size !== expected.size ||
      c.mappings.some((m) => !expected.has(m.sourceId) || m.destinationVersion === 'null')
    ) {
      ctx.addIssue({ code: 'custom', message: 'Incomplete or ambiguous mapping.' });
    }
    if (c.mappings.some((m) => m.mode === 'native' && m.destinationVersion !== c.sources.find((s) => s.sourceId === m.sourceId)?.observedVersion))
      ctx.addIssue({ code: 'custom', message: 'Native identity changed.' });
  });
export const completionSchema = z
  .object({
    domain: z.literal('telesphoros-evidence/completion/1'),
    generation: generationSchema,
    binding: bindingSchema,
    catalogueSha256: hash,
    catalogueVersion: bounded.refine((v) => v !== 'null'),
    referenceCount: count.max(MAX_REFERENCES),
    objectCount: count.max(MAX_REFERENCES),
  })
  .strict()
  .refine((c) => c.objectCount <= c.referenceCount);
export type EvidenceCheckpoint = z.infer<typeof checkpointSchema>;
export type EvidenceCatalogue = z.infer<typeof catalogueSchema>;
export type EvidenceCompletion = z.infer<typeof completionSchema>;
export type EvidenceDocument = EvidenceCheckpoint | EvidenceCatalogue | EvidenceCompletion;
export const digest = (value: unknown): string => createHash('sha256').update(stableStringify(value)).digest('hex');
export const byteDigest = (value: Buffer): string => createHash('sha256').update(value).digest('hex');
export function backupBinding(manifest: BackupManifestV2): EvidenceBinding {
  return parse(bindingSchema, {
    manifestSha256: digest(manifest),
    archiveSha256: manifest.dump.sha256,
    plaintextSha256: manifest.dump.plaintextSha256,
    schemaSha256: digest({ migrations: manifest.migrations, tables: manifest.tables, schema: manifest.schema, privileges: manifest.privileges ?? null }),
    migrations: manifest.migrations,
    createdAt: manifest.createdAt,
  });
}
export function parse<T>(schema: z.ZodType<T>, raw: unknown): T {
  const result = schema.safeParse(raw);
  if (!result.success) throw new EvidenceError('schema');
  return result.data;
}

/** Membership is a set of references, not merely a count of objects. */
export function validateSources(items: ResolvedEvidence[], bucket: string): void {
  const references = new Set<string>();
  for (const item of items) {
    const r = item.reference;
    const id = digest({ tenant: r.tenantId, report: r.reportId, capture: r.captureId, kind: r.kind });
    if (
      references.has(id) ||
      item.sourceId !== sourceIdentity(bucket, item) ||
      (r.dbVersion !== null && item.observedVersion !== r.dbVersion) ||
      (r.sizeBytes !== null && item.bytes !== r.sizeBytes)
    )
      throw new EvidenceError('integrity');
    references.add(id);
  }
}
export const sourceIdentity = (bucket: string, item: Pick<ResolvedEvidence, 'reference' | 'observedVersion' | 'bytes'>): string =>
  digest({
    bucket,
    key: item.reference.key,
    version: item.observedVersion,
    sha256: item.reference.sha256,
    bytes: item.bytes,
    contentType: item.reference.contentType,
  });

const envelopeSchema = z.object({ format: z.literal(1), salt: z.string().regex(/^[0-9a-f]{32}$/), payload: z.unknown(), mac: hash }).strict();
export function signDocument(document: EvidenceDocument, key: Buffer): Buffer {
  const salt = randomBytes(16).toString('hex');
  const unsigned = { format: 1 as const, salt, payload: document };
  const bytes = Buffer.from(stableStringify({ ...unsigned, mac: manifestMac(unsigned, key, salt) }));
  if (bytes.length > CATALOGUE_MAX_BYTES) throw new EvidenceError('limit');
  return bytes;
}
export function authenticateDocument<T>(bytes: Buffer, key: Buffer, schema: z.ZodType<T>): T {
  if (bytes.length > CATALOGUE_MAX_BYTES) throw new EvidenceError('limit');
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new EvidenceError('schema');
  }
  const envelope = parse(envelopeSchema, raw);
  if (!verifyManifestMac(envelope, key, envelope.salt)) throw new EvidenceError('authentication');
  return parse(schema, envelope.payload);
}
/** Existing AES-GCM file format; distinct catalogue key and authenticated payload domains. */
export async function encryptDocument(document: EvidenceDocument, key: Buffer): Promise<Buffer> {
  const work = makeTempDir('restore-');
  try {
    const plain = join(work.path, 'document.json');
    const encrypted = join(work.path, 'document.enc');
    await writeFile(plain, signDocument(document, key), { mode: 0o600, flag: 'wx' });
    await encryptFile(plain, encrypted, key);
    return await readFile(encrypted);
  } finally {
    work.dispose();
  }
}
export async function decryptDocument<T>(bytes: Buffer, key: Buffer, schema: z.ZodType<T>): Promise<T> {
  if (bytes.length > CATALOGUE_MAX_BYTES + 65536) throw new EvidenceError('limit');
  const work = makeTempDir('restore-');
  try {
    const encrypted = join(work.path, 'document.enc');
    const plain = join(work.path, 'document.json');
    await writeFile(encrypted, bytes, { mode: 0o600, flag: 'wx' });
    try {
      await decryptFile(encrypted, plain, key);
    } catch {
      throw new EvidenceError('authentication');
    }
    return authenticateDocument(await readFile(plain), key, schema);
  } finally {
    work.dispose();
  }
}
