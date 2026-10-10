/** F2 TEST ONLY. No app resolver, CLI, storage provider or production deployment. */
import { timingSafeEqual } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { manifestMac, readKeyFile, verifyManifestMac } from '../../src/db/backup-crypto';
import { parseManifest } from '../../src/db/backup-manifest';
import { backupBinding, byteDigest, CATALOGUE_MAX_BYTES, catalogueSchema, completionSchema, decryptDocument, digest, EvidenceError, parse, policySchema, generationSchema, type EvidenceCatalogue, type EvidencePolicy, type ResolvedEvidence } from '../../src/db/evidence-catalogue';
import { readEvidenceInventory } from '../../src/db/evidence-inventory';
import { EvidenceBudget, listVersions, verifyPolicy, type EvidenceLimits, type EvidenceObject, type EvidenceStorage } from '../../src/db/evidence-storage';
import { makeTempDir } from '../../src/db/cleanup';
import { restoreAndVerify } from '../../src/db/restore';

export interface RecoveryProbeOptions {
  adminUrl: string; backupKeyFile: string; catalogueKeyFile: string;
  generation: string; sourceBucket: string; policy: EvidencePolicy;
  copy: EvidenceStorage; backup: EvidenceStorage; recovery: EvidenceStorage;
  backupManifest: { key: string; version: string }; backupArchive: { key: string; version: string };
  limits?: Partial<EvidenceLimits>;
}
const volume = (bytes: number) => ({ bytes, GB: bytes / 1e9, GiB: bytes / 1024 ** 3 });
const seconds = (start: number) => (performance.now() - start) / 1000;

/** Native is a distinct contract: this fixture does not claim Moto replicates VersionIds. */
export function mappingLocation(catalogue: EvidenceCatalogue, item: ResolvedEvidence) {
  const mapping = catalogue.mappings.find(m => m.sourceId === item.sourceId);
  if (!mapping) throw new EvidenceError('missing');
  if (mapping.mode === 'native') {
    if (mapping.destinationVersion !== item.observedVersion) throw new EvidenceError('integrity');
    return { key: item.reference.key, version: item.observedVersion, mode: 'native' as const };
  }
  return { key: catalogue.destinationPrefix + catalogue.generation + '/objects/' + item.sourceId,
    version: mapping.destinationVersion, mode: 'translated' as const };
}

async function exact(store: EvidenceStorage, key: string, version: string, limit: number, policy: EvidencePolicy, budget: EvidenceBudget): Promise<EvidenceObject> {
  if (!version || version === 'null') throw new EvidenceError('integrity');
  const object = await store.get(key, version, limit, budget);
  if (!object) throw new EvidenceError('missing');
  if (object.version !== version || byteDigest(object.bytes) !== object.sha256) throw new EvidenceError('integrity');
  verifyPolicy(object, policy, budget); return object;
}

export async function independentRecoveryProbe(options: RecoveryProbeOptions) {
  const start = performance.now(); const budget = new EvidenceBudget(options.limits);
  const generation = parse(generationSchema, options.generation); const policy = parse(policySchema, options.policy);
  if (new Set([options.sourceBucket, options.copy.bucket, options.backup.bucket, options.recovery.bucket]).size !== 4 || Date.parse(policy.retainUntil) <= Date.now()) throw new EvidenceError('policy');
  let backupKey: Buffer; let catalogueKey: Buffer;
  try { backupKey = await readKeyFile(options.backupKeyFile); catalogueKey = await readKeyFile(options.catalogueKeyFile); }
  catch { throw new EvidenceError('authentication'); }
  if (timingSafeEqual(backupKey, catalogueKey)) throw new EvidenceError('authentication');
  // No source storage port, producer result, cached object payload or local backup directory is accepted.
  const downloadStart = performance.now();
  const manifestObject = await exact(options.backup, options.backupManifest.key, options.backupManifest.version, CATALOGUE_MAX_BYTES, policy, budget);
  let manifest;
  try { manifest = parseManifest(new TextDecoder('utf-8', { fatal: true }).decode(manifestObject.bytes)); }
  catch { throw new EvidenceError('binding'); }
  if (manifest.formatVersion !== 2 || !verifyManifestMac(manifest, backupKey, manifest.dump.encryption.salt)) throw new EvidenceError('authentication');
  const binding = backupBinding(manifest);
  const archive = await exact(options.backup, options.backupArchive.key, options.backupArchive.version, manifest.dump.bytes, policy, budget);
  if (archive.bytes.length !== manifest.dump.bytes || archive.sha256 !== manifest.dump.sha256) throw new EvidenceError('integrity');
  const backupSeconds = seconds(downloadStart);
  const catalogueStart = performance.now(); const base = options.copy.prefix + generation + '/';
  const completions = await listVersions(options.copy, base + 'completion.enc', budget);
  if (!completions.length) throw new EvidenceError('missing');
  if (completions.length !== 1 || completions[0].deleted) throw new EvidenceError('ambiguous');
  const completed = await exact(options.copy, base + 'completion.enc', completions[0].version, CATALOGUE_MAX_BYTES + 65536, policy, budget);
  const completion = await decryptDocument(completed.bytes, catalogueKey, completionSchema);
  if (completed.contentType !== 'application/octet-stream' || completion.generation !== generation || digest(completion.binding) !== digest(binding)) throw new EvidenceError('binding');
  const published = await exact(options.copy, base + 'catalogue.enc', completion.catalogueVersion, CATALOGUE_MAX_BYTES + 65536, policy, budget);
  if (published.contentType !== 'application/octet-stream' || published.sha256 !== completion.catalogueSha256) throw new EvidenceError('integrity');
  const catalogue = await decryptDocument(published.bytes, catalogueKey, catalogueSchema);
  const unique = new Map(catalogue.sources.map(s => [s.sourceId, s]));
  if (catalogue.generation !== generation || catalogue.sourceBucket !== options.sourceBucket || catalogue.destinationBucket !== options.copy.bucket || catalogue.destinationPrefix !== options.copy.prefix || digest(catalogue.binding) !== digest(binding) || digest(catalogue.policy) !== digest(policy) || completion.referenceCount !== catalogue.sources.length || completion.objectCount !== unique.size) throw new EvidenceError('binding');
  // F2's healthy fixture uses translated copies only. Native resolution is separately contract-tested.
  if (catalogue.mappings.some(m => m.mode !== 'translated')) throw new EvidenceError('binding');
  const catalogueSeconds = seconds(catalogueStart); const work = makeTempDir('restore-dl-');
  let restoredBytes = 0; let recoveredBytes = 0; let recoveredObjects = 0; let verificationSeconds = 0;
  const restoreStart = performance.now();
  try {
    await writeFile(join(work.path, 'manifest.json'), manifestObject.bytes, { mode: 0o600, flag: 'wx' });
    await writeFile(join(work.path, 'db.dump.enc'), archive.bytes, { mode: 0o600, flag: 'wx' });
    let callbackError: unknown;
    const restored = await restoreAndVerify({ adminUrl: options.adminUrl, backupDir: work.path, keyFile: options.backupKeyFile,
      operationTimeoutMs: budget.remainingMs(), assertBudget: () => budget.check(), afterVerified: async url => {
        try {
          const inventory = await readEvidenceInventory(url, budget); restoredBytes = inventory.restoredDatabaseBytes;
          if (digest(inventory.references) !== digest(catalogue.sources.map(s => s.reference)) || inventory.uncompletedRegistrations !== catalogue.uncompletedRegistrations) throw new EvidenceError('binding');
          const verifyStart = performance.now();
          for (const [sourceId, item] of unique) {
            const location = mappingLocation(catalogue, item);
            const object = await exact(options.copy, location.key, location.version, item.reference.kind === 'text' ? 400_000 : item.bytes, policy, budget);
            const ref = item.reference;
            if (object.bytes.length !== item.bytes || object.sha256 !== ref.sha256 || object.contentType !== ref.contentType) throw new EvidenceError('integrity');
            if (ref.scalars !== null) {
              let count: number;
              try { count = [...new TextDecoder('utf-8', { fatal: true }).decode(object.bytes)].length; }
              catch { throw new EvidenceError('integrity'); }
              if (count !== ref.scalars) throw new EvidenceError('integrity');
            }
            const token = manifestMac({ domain: 'telesphoros-evidence/stage-token/1', generation, binding, destinationBucket: options.copy.bucket, destinationPrefix: options.copy.prefix, id: sourceId }, catalogueKey, digest({ binding, generation }).slice(0, 32));
            if (object.token !== token) throw new EvidenceError('integrity');
            // Install into an owned recovery bucket, never write the independent copy or primary.
            const key = options.recovery.prefix + generation + '/' + sourceId;
            let versions = await listVersions(options.recovery, key, budget);
            if (versions.length === 0) {
              try { await options.recovery.put(key, object.bytes, object.contentType, token, policy, budget); }
              catch (error) { if (!(error instanceof EvidenceError) || error.code !== 'storage') throw error; }
              // Uncertain replies are resolved by exhaustive discovery; never blindly repeat PUT.
              versions = await listVersions(options.recovery, key, budget);
            }
            if (versions.length !== 1 || versions[0].deleted) throw new EvidenceError('ambiguous');
            const recovered = await exact(options.recovery, key, versions[0].version, item.bytes, policy, budget);
            if (recovered.sha256 !== ref.sha256 || recovered.bytes.length !== item.bytes || recovered.contentType !== ref.contentType || recovered.token !== token) throw new EvidenceError('integrity');
            recoveredBytes += object.bytes.length; recoveredObjects++;
          }
          verificationSeconds = seconds(verifyStart);
        } catch (error) { callbackError = error; throw error; }
      },
    });
    if (callbackError) throw callbackError;
    if (!restored.ok) throw new EvidenceError('binding');
    budget.check();
    return { format: 1, databaseRecoveryVerified: true, independentBytesRecovered: true, applicationRecoveryComplete: false,
      identityMode: 'translated-test-only', references: catalogue.sources.length, recoveredObjects,
      requiredByKind: Object.fromEntries(['lab-pdf', 'vcf', 'structured', 'text'].map(kind => {
        const objects = [...unique.values()].filter(s => s.reference.kind === kind);
        return [kind, { objects: objects.length, ...volume(objects.reduce((sum, s) => sum + s.bytes, 0)) }];
      })),
      volumes: { restoredDatabase: volume(restoredBytes), archive: volume(archive.bytes.length), catalogue: volume(published.bytes.length), recoveredObjects: volume(recoveredBytes), read: volume(budget.readBytes), writeAttempted: volume(budget.writtenBytes) },
      seconds: { backupDownload: backupSeconds, catalogue: catalogueSeconds, restoreAndEvidence: seconds(restoreStart), evidenceVerification: verificationSeconds, total: seconds(start) }, concurrency: 1 };
  } finally { work.dispose(); }
}
