import { MAX_REPORT_BYTES } from '@telesphoros/shared-types';
import { AppException } from '../common/app-exception';
import { byteDigest, catalogueSchema, decryptDocument, digest, EvidenceError, type EvidenceBinding, type EvidenceReference, type ResolvedEvidence } from '../db/evidence-catalogue';
import { type FetchedObject, ObjectStorage, ObjectTooLargeError } from './object-storage';

export interface RecoveryStorageOptions {
  /** An encrypted, authenticated catalogue of the INSTALLED application copies, produced by the trusted recovery loader. */
  encryptedCatalogue: Buffer;
  catalogueKey: Buffer;
  /** Derived by the trusted loader from the verified DB restore, never from an HTTP request or the catalogue itself. */
  expected: {
    binding: EvidenceBinding; references: EvidenceReference[]; uncompletedRegistrations: number;
    sourceBucket: string; destinationBucket: string; destinationPrefix: string;
  };
  /** Configured independently for exactly destinationBucket; use an application read-only credential, not the loader/copy credential. */
  target: ObjectStorage & { readonly bucket: string };
}
interface Entry { source: ResolvedEvidence; key: string; version: string; logicalVersion: string }

/**
 * Opt-in recovery library. No environment switch or automatic production activation.
 * Authentication keys/DB administrator access stay in the loader; the returned adapter holds only a validated index and read port.
 * Original DB pins remain original identities. Only the outbound storage request/link uses the installed destination identity.
 */
export class RecoveryObjectStorage extends ObjectStorage {
  private readonly entries = new Map<string, Entry[]>();
  private constructor(private readonly target: ObjectStorage, entries: Entry[]) {
    super();
    for (const entry of entries) this.entries.set(entry.source.reference.key, [...(this.entries.get(entry.source.reference.key) ?? []), entry]);
  }

  static async open(options: RecoveryStorageOptions): Promise<RecoveryObjectStorage> {
    const catalogue = await decryptDocument(options.encryptedCatalogue, options.catalogueKey, catalogueSchema);
    const { expected } = options;
    if (options.target.bucket !== expected.destinationBucket || catalogue.sourceBucket === catalogue.destinationBucket || catalogue.sourceBucket !== expected.sourceBucket ||
      catalogue.destinationBucket !== expected.destinationBucket || catalogue.destinationPrefix !== expected.destinationPrefix ||
      digest(catalogue.binding) !== digest(expected.binding) || digest(catalogue.sources.map(s => s.reference)) !== digest(expected.references) ||
      catalogue.uncompletedRegistrations !== expected.uncompletedRegistrations || Date.parse(catalogue.policy.retainUntil) <= Date.now()) throw new EvidenceError('binding');
    const unique = new Map(catalogue.sources.map(s => [s.sourceId, s]));
    const entries = [...unique.values()].map(source => {
      const mapping = catalogue.mappings.find(m => m.sourceId === source.sourceId)!;
      return { source, key: mapping.mode === 'native' ? source.reference.key : catalogue.destinationPrefix + catalogue.generation + '/objects/' + source.sourceId,
        version: mapping.destinationVersion, logicalVersion: source.reference.dbVersion ?? source.observedVersion };
    });
    // An unversioned caller cannot choose between different original identities for the same key.
    // Explicitly pinned reads remain supported, but reject two different destinations for one logical identity.
    const identities = new Set<string>();
    for (const e of entries) {
      if (e.source.bytes > (e.source.reference.kind === 'text' ? 400_000 : MAX_REPORT_BYTES)) throw new EvidenceError('limit');
      const identity = JSON.stringify([e.source.reference.key, e.logicalVersion]);
      if (identities.has(identity)) throw new EvidenceError('ambiguous');
      identities.add(identity);
    }
    const storage = new RecoveryObjectStorage(options.target, entries);
    if (!(await options.target.versioningEnabled())) throw new EvidenceError('policy');
    // Verify ALL required objects, including soft-deleted references, before exposing any application provider.
    for (const entry of entries) await storage.read(entry, entry.source.bytes);
    return storage;
  }

  private resolve(key: string, version?: string): Entry {
    const entries = (this.entries.get(key) ?? []).filter(e => version === undefined || e.logicalVersion === version);
    if (!entries.length) throw new EvidenceError('missing');
    if (entries.length !== 1) throw new EvidenceError('ambiguous');
    return entries[0];
  }

  private async read(entry: Entry, maxBytes: number): Promise<FetchedObject> {
    const { source, key, version, logicalVersion } = entry;
    const fetched = await this.target.getObject(key, { version, maxBytes: Math.min(maxBytes, source.bytes) });
    if (!fetched) throw new EvidenceError('missing');
    const ref = source.reference;
    if (fetched.version !== version || fetched.sizeBytes !== source.bytes || fetched.bytes.length !== source.bytes ||
      fetched.sha256 !== ref.sha256 || byteDigest(fetched.bytes) !== ref.sha256 || fetched.contentType !== ref.contentType) throw new EvidenceError('integrity');
    if (ref.scalars !== null) {
      try { if ([...new TextDecoder('utf-8', { fatal: true }).decode(fetched.bytes)].length !== ref.scalars) throw new EvidenceError('integrity'); }
      catch { throw new EvidenceError('integrity'); }
    }
    return { ...fetched, version: logicalVersion };
  }

  async inspect(key: string, options: { version?: string } = {}) {
    const { sizeBytes, contentType, sha256, version } = await this.getObject(key, { ...options, maxBytes: MAX_REPORT_BYTES });
    return { sizeBytes, contentType, sha256, version };
  }
  async getObject(key: string, options: { version?: string; maxBytes: number }): Promise<FetchedObject> {
    if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 0) throw new ObjectTooLargeError(0);
    const entry = this.resolve(key, options.version);
    if (entry.source.bytes > options.maxBytes) throw new ObjectTooLargeError(options.maxBytes);
    return this.read(entry, options.maxBytes);
  }
  async createDownloadUrl(key: string, version: string, ttlSeconds: number): Promise<string> {
    if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > 900) throw new EvidenceError('policy');
    const entry = this.resolve(key, version);
    await this.read(entry, entry.source.bytes); // exact bytes verified again before signing; never signs a missing/corrupt substitute
    return this.target.createDownloadUrl(entry.key, entry.version, ttlSeconds);
  }
  async versioningEnabled(): Promise<boolean> { return this.target.versioningEnabled(); }
  async createUploadTarget(): Promise<never> { throw AppException.unavailable('Recovery file storage is read only.'); }
  async putObject(): Promise<never> { throw AppException.unavailable('Recovery file storage is read only.'); }
}
