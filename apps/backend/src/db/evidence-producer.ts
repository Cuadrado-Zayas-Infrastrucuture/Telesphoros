import { timingSafeEqual } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { manifestMac, readKeyFile, verifyManifestMac } from './backup-crypto';
import { parseManifest } from './backup-manifest';
import {
  backupBinding,
  byteDigest,
  CATALOGUE_MAX_BYTES,
  catalogueSchema,
  checkpointSchema,
  completionSchema,
  decryptDocument,
  digest,
  encryptDocument,
  EvidenceError,
  EvidenceObjectTooLargeError,
  generationSchema,
  parse,
  policySchema,
  sourceIdentity,
  validateSources,
  type EvidenceBinding,
  type EvidenceCatalogue,
  type EvidenceCheckpoint,
  type EvidenceCompletion,
  type EvidencePolicy,
  type EvidenceReference,
  type ResolvedEvidence,
} from './evidence-catalogue';
import { readEvidenceInventory, type EvidenceInventory } from './evidence-inventory';
import { EvidenceBudget, listKeys, listVersions, verifyPolicy, type EvidenceLimits, type EvidenceObject, type EvidenceStorage } from './evidence-storage';
import { restoreAndVerify } from './restore';

export interface CatalogueOptions {
  /** Explicit administrative target-server connection for a NEW throwaway restore; never a named existing target. */
  adminUrl: string;
  backupDir: string;
  backupKeyFile: string;
  catalogueKeyFile: string;
  generation: string;
  source: EvidenceStorage;
  destination: EvidenceStorage;
  policy: EvidencePolicy;
  limits?: Partial<EvidenceLimits>;
}
export interface CatalogueMetrics {
  format: 1;
  references: number;
  uniqueObjects: number;
  uncompletedRegistrations: number;
  orphanTextObjects: number;
  copiedObjectsVerified: number;
  copiedBytesVerified: number;
  requiredByKind: Record<EvidenceReference['kind'], { objects: number; bytes: number; GB: number; GiB: number }>;
  /** Read counts consumed response bytes; writeAttempted counts submitted payloads, not measured network traffic. */
  volumes: Record<'restoredDatabase' | 'archive' | 'catalogue' | 'requiredObjects' | 'read' | 'writeAttempted', { bytes: number; GB: number; GiB: number }>;
  seconds: Record<'restoreAndInventory' | 'resolve' | 'copyAndVerify' | 'publish' | 'total', number>;
  concurrency: 1;
  independentBytesRecovered: false;
  applicationRecoveryComplete: false;
}
export interface CatalogueResult {
  catalogue: EvidenceCatalogue;
  completion: EvidenceCompletion;
  metrics: CatalogueMetrics;
}
const volume = (bytes: number) => ({ bytes, GB: bytes / 1e9, GiB: bytes / 1024 ** 3 });
const elapsed = (start: number) => (performance.now() - start) / 1000;

function matches(ref: EvidenceReference, object: EvidenceObject): boolean {
  if (
    byteDigest(object.bytes) !== ref.sha256 ||
    object.sha256 !== ref.sha256 ||
    object.contentType !== ref.contentType ||
    (ref.sizeBytes !== null && ref.sizeBytes !== object.bytes.length)
  )
    return false;
  if (ref.scalars !== null) {
    try {
      if ([...new TextDecoder('utf-8', { fatal: true }).decode(object.bytes)].length !== ref.scalars) return false;
    } catch {
      return false;
    }
  }
  return true;
}
const objectLimit = (ref: EvidenceReference) => (ref.kind === 'text' ? 400_000 : ref.sizeBytes!);
async function sourceObject(store: EvidenceStorage, item: ResolvedEvidence, budget: EvidenceBudget): Promise<EvidenceObject> {
  const object = await store.get(item.reference.key, item.observedVersion, objectLimit(item.reference), budget);
  if (!object) throw new EvidenceError('missing');
  if (object.version !== item.observedVersion || object.bytes.length !== item.bytes || !matches(item.reference, object)) throw new EvidenceError('integrity');
  return object;
}
async function resolveSource(store: EvidenceStorage, reference: EvidenceReference, budget: EvidenceBudget): Promise<ResolvedEvidence> {
  const candidateAt = async (version: string | undefined) => {
    try {
      return await store.get(reference.key, version, objectLimit(reference), budget);
    } catch (e) {
      // A larger unrelated current/historical object is a mismatch; global budget failures still abort.
      if (reference.dbVersion === null && e instanceof EvidenceObjectTooLargeError) return undefined;
      throw e;
    }
  };
  let object = await candidateAt(reference.dbVersion ?? undefined);
  if (reference.dbVersion !== null) {
    if (!object) throw new EvidenceError('missing');
    if (object.version !== reference.dbVersion || !matches(reference, object)) throw new EvidenceError('integrity');
  } else if (!object || !matches(reference, object)) {
    object = undefined;
    // Exhaust discovery before using a match; sorting is deterministic, not a claim of recency.
    const versions = (await listVersions(store, reference.key, budget)).filter((v) => !v.deleted).sort((a, b) => a.version.localeCompare(b.version));
    for (const v of versions) {
      const candidate = await candidateAt(v.version);
      if (candidate && candidate.version === v.version && matches(reference, candidate) && !object) object = candidate;
    }
    if (!object) throw new EvidenceError('missing');
  }
  const item = { reference, observedVersion: object!.version, bytes: object!.bytes.length, sourceId: '' };
  item.sourceId = sourceIdentity(store.bucket, item);
  return item;
}

/** Retained generation keys are append-only. Any foreign, duplicated or deleted stage refuses resume. */
async function findStage(store: EvidenceStorage, key: string, token: string, limit: number, policy: EvidencePolicy, budget: EvidenceBudget): Promise<EvidenceObject | undefined> {
  const versions = await listVersions(store, key, budget);
  if (versions.length === 0) return undefined;
  if (versions.length !== 1 || versions[0].deleted) throw new EvidenceError('ambiguous');
  const object = await store.get(key, versions[0].version, limit, budget);
  if (!object || object.version !== versions[0].version || object.token !== token || byteDigest(object.bytes) !== object.sha256) throw new EvidenceError('integrity');
  verifyPolicy(object, policy, budget);
  return object;
}
async function stage(
  store: EvidenceStorage,
  key: string,
  token: string,
  bytes: Buffer,
  contentType: string,
  limit: number,
  policy: EvidencePolicy,
  budget: EvidenceBudget,
): Promise<EvidenceObject> {
  let writeError: unknown;
  try {
    await store.put(key, bytes, contentType, token, policy, budget);
  } catch (e) {
    if (!(e instanceof EvidenceError) || e.code !== 'storage') throw e;
    writeError = e;
  }
  // A lost reply is recovered by exact-version discovery/read-back, never by blindly repeating PUT.
  const object = await findStage(store, key, token, limit, policy, budget);
  if (!object) {
    if (writeError) throw writeError;
    throw new EvidenceError('missing');
  }
  return object;
}

export async function produceEvidenceCatalogue(options: CatalogueOptions): Promise<CatalogueResult> {
  const totalStart = performance.now();
  const budget = new EvidenceBudget(options.limits);
  const generation = parse(generationSchema, options.generation);
  const policy = parse(policySchema, options.policy);
  if (Date.parse(policy.retainUntil) <= Date.now() || options.source.bucket === options.destination.bucket) throw new EvidenceError('policy');
  // F1 is an ops library with no application/CLI credential fallback. Keys are independently supplied.
  let backupKey: Buffer;
  let catalogueKey: Buffer;
  try {
    backupKey = await readKeyFile(options.backupKeyFile);
    catalogueKey = await readKeyFile(options.catalogueKeyFile);
  } catch {
    throw new EvidenceError('authentication');
  }
  if (timingSafeEqual(backupKey, catalogueKey)) throw new EvidenceError('authentication');
  const manifestPath = join(options.backupDir, 'manifest.json');
  const boundedManifest = async () => {
    try {
      if ((await stat(manifestPath)).size > CATALOGUE_MAX_BYTES) throw new EvidenceError('limit');
      const bytes = await readFile(manifestPath);
      if (bytes.length > CATALOGUE_MAX_BYTES) throw new EvidenceError('limit');
      return parseManifest(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    } catch (e) {
      if (e instanceof EvidenceError) throw e;
      throw new EvidenceError('binding');
    }
  };
  await boundedManifest();
  let binding: EvidenceBinding | undefined;
  let inventory: EvidenceInventory | undefined;
  let archiveBytes = 0;
  const restoreStart = performance.now();
  const restored = await restoreAndVerify({
    adminUrl: options.adminUrl,
    backupDir: options.backupDir,
    keyFile: options.backupKeyFile,
    operationTimeoutMs: budget.remainingMs(),
    assertBudget: () => budget.check(),
    afterVerified: async (url, manifest) => {
      if (manifest.formatVersion !== 2) throw new EvidenceError('binding');
      binding = backupBinding(manifest);
      archiveBytes = manifest.dump.bytes;
      inventory = await readEvidenceInventory(url, budget);
    },
  }).catch((e: unknown) => {
    if (e instanceof EvidenceError) throw e;
    throw new EvidenceError('binding');
  });
  if (!restored.ok || !binding || !inventory) throw new EvidenceError('binding');
  budget.check();
  const restoreSeconds = elapsed(restoreStart);
  // Refuse local backup mutation across restoration/binding rather than correlating unrelated live scans.
  const manifest = await boundedManifest();
  if (manifest.formatVersion !== 2 || !verifyManifestMac(manifest, backupKey, manifest.dump.encryption.salt) || digest(backupBinding(manifest)) !== digest(binding))
    throw new EvidenceError('binding');
  const base = options.destination.prefix + generation + '/';
  const token = (id: string) =>
    manifestMac(
      { domain: 'telesphoros-evidence/stage-token/1', generation, binding, destinationBucket: options.destination.bucket, destinationPrefix: options.destination.prefix, id },
      catalogueKey,
      digest({ binding, generation }).slice(0, 32),
    );
  const checkpointKey = base + 'checkpoint.enc';
  const resolveStart = performance.now();
  let checkpoint: EvidenceCheckpoint;
  const existing = await findStage(options.destination, checkpointKey, token('checkpoint'), CATALOGUE_MAX_BYTES + 65536, policy, budget);
  if (existing) {
    if (existing.contentType !== 'application/octet-stream') throw new EvidenceError('integrity');
    checkpoint = await decryptDocument(existing.bytes, catalogueKey, checkpointSchema);
    if (
      checkpoint.generation !== generation ||
      digest(checkpoint.binding) !== digest(binding) ||
      digest(checkpoint.policy) !== digest(policy) ||
      checkpoint.sourceBucket !== options.source.bucket ||
      checkpoint.destinationBucket !== options.destination.bucket ||
      checkpoint.destinationPrefix !== options.destination.prefix ||
      digest(checkpoint.sources.map((s) => s.reference)) !== digest(inventory.references) ||
      checkpoint.uncompletedRegistrations !== inventory.uncompletedRegistrations
    )
      throw new EvidenceError('binding');
  } else {
    const sources: ResolvedEvidence[] = [];
    for (const reference of inventory.references) sources.push(await resolveSource(options.source, reference, budget));
    const knownText = new Set(inventory.references.filter((r) => r.kind === 'text').map((r) => r.key));
    const orphanTextObjects = (await listKeys(options.source, budget)).filter((key) => key.includes('/text/') && !knownText.has(key)).length;
    checkpoint = parse(checkpointSchema, {
      domain: 'telesphoros-evidence/checkpoint/1',
      generation,
      producedAt: new Date().toISOString(),
      binding,
      policy,
      sourceBucket: options.source.bucket,
      destinationBucket: options.destination.bucket,
      destinationPrefix: options.destination.prefix,
      uncompletedRegistrations: inventory.uncompletedRegistrations,
      orphanTextObjects,
      sources,
    });
    validateSources(checkpoint.sources, checkpoint.sourceBucket);
    const bytes = await encryptDocument(checkpoint, catalogueKey);
    const saved = await stage(options.destination, checkpointKey, token('checkpoint'), bytes, 'application/octet-stream', CATALOGUE_MAX_BYTES + 65536, policy, budget);
    if (digest(await decryptDocument(saved.bytes, catalogueKey, checkpointSchema)) !== digest(checkpoint)) throw new EvidenceError('binding');
  }
  validateSources(checkpoint.sources, checkpoint.sourceBucket);
  const resolveSeconds = elapsed(resolveStart);
  const copyStart = performance.now();
  const unique = new Map(checkpoint.sources.map((s) => [s.sourceId, s]));
  const mappings: EvidenceCatalogue['mappings'] = [];
  for (const [sourceId, item] of unique) {
    // Re-read frozen source versions even on resume; no current-object substitution.
    const source = await sourceObject(options.source, item, budget);
    const key = base + 'objects/' + sourceId;
    let copy = await findStage(options.destination, key, token(sourceId), objectLimit(item.reference), policy, budget);
    if (!copy) copy = await stage(options.destination, key, token(sourceId), source.bytes, item.reference.contentType, objectLimit(item.reference), policy, budget);
    if (!matches(item.reference, copy) || copy.bytes.length !== item.bytes) throw new EvidenceError('integrity');
    mappings.push({ sourceId, destinationVersion: copy.version, mode: 'translated' });
  }
  const copySeconds = elapsed(copyStart);
  const publishStart = performance.now();
  const catalogue = parse(catalogueSchema, { ...checkpoint, domain: 'telesphoros-evidence/catalogue/1', mappings });
  const catalogueKeyName = base + 'catalogue.enc';
  let published = await findStage(options.destination, catalogueKeyName, token('catalogue'), CATALOGUE_MAX_BYTES + 65536, policy, budget);
  if (!published)
    published = await stage(
      options.destination,
      catalogueKeyName,
      token('catalogue'),
      await encryptDocument(catalogue, catalogueKey),
      'application/octet-stream',
      CATALOGUE_MAX_BYTES + 65536,
      policy,
      budget,
    );
  if (published.contentType !== 'application/octet-stream' || digest(await decryptDocument(published.bytes, catalogueKey, catalogueSchema)) !== digest(catalogue))
    throw new EvidenceError('binding');
  const completion = parse(completionSchema, {
    domain: 'telesphoros-evidence/completion/1',
    generation,
    binding,
    catalogueSha256: published.sha256,
    catalogueVersion: published.version,
    referenceCount: checkpoint.sources.length,
    objectCount: mappings.length,
  });
  const completionKey = base + 'completion.enc';
  let completed = await findStage(options.destination, completionKey, token('completion'), CATALOGUE_MAX_BYTES + 65536, policy, budget);
  if (!completed)
    completed = await stage(
      options.destination,
      completionKey,
      token('completion'),
      await encryptDocument(completion, catalogueKey),
      'application/octet-stream',
      CATALOGUE_MAX_BYTES + 65536,
      policy,
      budget,
    );
  if (completed.contentType !== 'application/octet-stream' || digest(await decryptDocument(completed.bytes, catalogueKey, completionSchema)) !== digest(completion))
    throw new EvidenceError('binding');
  budget.check();
  const requiredByKind: CatalogueMetrics['requiredByKind'] = {
    'lab-pdf': { objects: 0, ...volume(0) },
    structured: { objects: 0, ...volume(0) },
    text: { objects: 0, ...volume(0) },
  };
  for (const item of unique.values()) {
    const totals = requiredByKind[item.reference.kind];
    totals.objects++;
    totals.bytes += item.bytes;
    Object.assign(totals, volume(totals.bytes));
  }
  const requiredBytes = [...unique.values()].reduce((sum, s) => sum + s.bytes, 0);
  return {
    catalogue,
    completion,
    metrics: {
      format: 1,
      references: checkpoint.sources.length,
      uniqueObjects: unique.size,
      uncompletedRegistrations: checkpoint.uncompletedRegistrations,
      orphanTextObjects: checkpoint.orphanTextObjects,
      copiedObjectsVerified: unique.size,
      copiedBytesVerified: requiredBytes,
      requiredByKind,
      volumes: {
        restoredDatabase: volume(inventory.restoredDatabaseBytes),
        archive: volume(archiveBytes),
        catalogue: volume(published.bytes.length),
        requiredObjects: volume(requiredBytes),
        read: volume(budget.readBytes),
        writeAttempted: volume(budget.writtenBytes),
      },
      seconds: { restoreAndInventory: restoreSeconds, resolve: resolveSeconds, copyAndVerify: copySeconds, publish: elapsed(publishStart), total: elapsed(totalStart) },
      concurrency: 1,
      independentBytesRecovered: false,
      applicationRecoveryComplete: false,
    },
  };
}
