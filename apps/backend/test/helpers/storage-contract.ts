import { createHash, randomBytes } from 'node:crypto';
import type { ObjectStorage} from '../../src/object-storage/object-storage';
import { ObjectTooLargeError } from '../../src/object-storage/object-storage';

export interface ContractTarget {
  /** A store whose bucket keeps versions. */
  versioned: ObjectStorage;
  /** A store whose bucket does NOT keep versions. */
  unversioned: ObjectStorage;
  /** The uploader's PUT through the store's own upload target; returns the version the store reported (undefined if none). */
  upload(storage: ObjectStorage, key: string, bytes: Buffer): Promise<string | undefined>;
  /** Removes one version, as an operator with break-glass rights could. */
  deleteVersion(storage: ObjectStorage, key: string, version: string): Promise<void>;
}

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const key = (name: string) => `reports/t/${randomBytes(4).toString('hex')}/${name}`;

/** The rules every ObjectStorage must keep, run against the in-memory store and the S3 implementation alike. */
export function describeStorageContract(label: string, target: () => ContractTarget): void {
  describe(`${label}: object versions`, () => {
    it('reports, in the SAME response as the bytes, the version the write was given', async () => {
      const { versioned, upload } = target();
      const k = key('a');
      const bytes = randomBytes(2048);
      const written = await upload(versioned, k, bytes);
      expect(written).toEqual(expect.any(String));
      const inspected = await versioned.inspect(k);
      expect(inspected).toMatchObject({ sizeBytes: bytes.length, sha256: sha(bytes), version: written });
      const fetched = await versioned.getObject(k, { maxBytes: 4096 });
      expect(fetched).toMatchObject({ sha256: sha(bytes), version: written });
      expect(fetched!.bytes.equals(bytes)).toBe(true);
    });

    it('serves exactly the named version after an overwrite, and the unnamed read is the latest', async () => {
      const { versioned, upload } = target();
      const k = key('b');
      const v1Bytes = randomBytes(1024);
      const v2Bytes = randomBytes(1024);
      const v1 = (await upload(versioned, k, v1Bytes))!;
      const v2 = (await upload(versioned, k, v2Bytes))!;
      expect(v1).not.toBe(v2);
      expect(await versioned.inspect(k, { version: v1 })).toMatchObject({ sha256: sha(v1Bytes), version: v1 });
      expect((await versioned.getObject(k, { version: v1, maxBytes: 4096 }))!.bytes.equals(v1Bytes)).toBe(true);
      expect(await versioned.inspect(k)).toMatchObject({ sha256: sha(v2Bytes), version: v2 });
    });

    it('answers "missing" for a deleted or unknown version, and NEVER falls back to the latest', async () => {
      const { versioned, upload, deleteVersion } = target();
      const k = key('c');
      const v1 = (await upload(versioned, k, randomBytes(512)))!;
      await upload(versioned, k, randomBytes(512)); // V2 is current
      expect(await versioned.inspect(k, { version: v1 })).toBeDefined(); // control: V1 is there before the delete
      await deleteVersion(versioned, k, v1);
      expect(await versioned.inspect(k, { version: v1 })).toBeUndefined();
      expect(await versioned.getObject(k, { version: v1, maxBytes: 4096 })).toBeUndefined();
      expect(await versioned.inspect(k)).toBeDefined(); // control: the latest is still readable, so "missing" was about the version
      expect(await versioned.inspect(key('never-written'))).toBeUndefined();
    });

    it('refuses to hand back more than the caller allowed', async () => {
      const { versioned, upload } = target();
      const k = key('d');
      await upload(versioned, k, randomBytes(4096));
      await expect(versioned.getObject(k, { maxBytes: 1024 })).rejects.toBeInstanceOf(ObjectTooLargeError);
      expect(await versioned.getObject(k, { maxBytes: 4096 })).toBeDefined(); // control: exactly at the limit is fine
    });

    it('writes an object server-side and reports its version', async () => {
      const { versioned } = target();
      const k = key('e');
      const bytes = Buffer.from('synthetic extracted text', 'utf8');
      const { version } = await versioned.putObject(k, bytes, 'text/plain');
      expect(version).toEqual(expect.any(String));
      expect(await versioned.inspect(k, { version })).toMatchObject({ sha256: sha(bytes), version });
    });

    it('issues a download link for one named version only', async () => {
      const { versioned, upload } = target();
      const k = key('f');
      const v1 = (await upload(versioned, k, randomBytes(256)))!;
      const link = await versioned.createDownloadUrl(k, v1, 120);
      expect(link).toContain(encodeURIComponent(v1));
    });

    it('says whether versioning is on', async () => {
      const { versioned, unversioned } = target();
      expect(await versioned.versioningEnabled()).toBe(true);
      expect(await unversioned.versioningEnabled()).toBe(false);
    });

    it('gives an object in an unversioned bucket no usable version', async () => {
      const { unversioned, upload } = target();
      const k = key('g');
      const written = await upload(unversioned, k, randomBytes(256));
      expect(written).toBeUndefined();
      expect((await unversioned.inspect(k))!.version).toBeUndefined();
      expect((await unversioned.getObject(k, { maxBytes: 4096 }))!.version).toBeUndefined();
    });
  });
}
