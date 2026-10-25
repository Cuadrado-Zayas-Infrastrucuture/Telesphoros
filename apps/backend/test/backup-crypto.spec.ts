import { createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BackupCryptoError,
  decryptFile,
  encryptFile,
  generateKeyFile,
  keyIdHex,
  manifestMac,
  readEncryptionHeader,
  readKeyFile,
  stableStringify,
  verifyManifestMac,
} from '../src/db/backup-crypto';

const scratch = mkdtempSync(join(tmpdir(), 'backup-crypto-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
let counter = 0;
const path = (name: string) => join(scratch, `${counter++}-${name}`);
const master = Buffer.from(Array.from({ length: 32 }, (_, i) => i)); // the key of the known-answer test
const randomKey = () => randomBytes(32);

const HEADER = 37;
const TAG = 16;

/** Encrypts `plain`, returns the encrypted bytes. */
async function sealed(plain: Buffer, key: Buffer = randomKey(), chunkLog2?: number) {
  const input = path('in');
  const output = path('enc');
  writeFileSync(input, plain);
  const info = await encryptFile(input, output, key, { chunkLog2 });
  return { bytes: readFileSync(output), key, info, output };
}

/** Writes `bytes` to a file and tries to decrypt it; returns the error code, or 'ok'. Also checks that a failure leaves nothing behind. */
async function tryDecrypt(bytes: Buffer, key: Buffer): Promise<string> {
  const input = path('dec-in');
  const output = path('dec-out');
  writeFileSync(input, bytes);
  try {
    await decryptFile(input, output, key);
    return 'ok';
  } catch (error) {
    expect(error).toBeInstanceOf(BackupCryptoError);
    expect(existsSync(output)).toBe(false); // no plaintext survives a failed decryption
    return (error as BackupCryptoError).code;
  }
}

describe('round trip', () => {
  const sizes = [0, 1, 15, 16, 17, 63, 64, 65, 127, 128, 129, 191, 192, 193, 1000];
  it.each(sizes)('restores %i bytes exactly with 64-byte chunks (every chunk boundary)', async (size) => {
    const plain = randomBytes(size);
    const { bytes, key } = await sealed(plain, randomKey(), 6);
    const chunks = Math.max(1, Math.ceil(size / 64));
    expect(bytes.length).toBe(HEADER + size + chunks * TAG); // exactly one tag per chunk, nothing else
    const output = path('out');
    const input = path('in2');
    writeFileSync(input, bytes);
    await decryptFile(input, output, key);
    expect(readFileSync(output).equals(plain)).toBe(true);
  });

  it.each([2 ** 20 - 1, 2 ** 20, 2 ** 20 + 1, 2 ** 21])('restores %i bytes at the default 1 MiB chunk size', async (size) => {
    const plain = randomBytes(size);
    const { bytes, key } = await sealed(plain);
    expect(bytes.length).toBe(HEADER + size + Math.ceil(size / 2 ** 20) * TAG);
    const input = path('in2');
    const output = path('out');
    writeFileSync(input, bytes);
    await decryptFile(input, output, key);
    expect(readFileSync(output).equals(plain)).toBe(true);
  });

  it('writes owner-only, never overwrites, and uses a fresh salt and nonce prefix each time', async () => {
    const plain = randomBytes(300);
    const a = await sealed(plain, master, 6);
    const b = await sealed(plain, master, 6);
    expect(statSync(a.output).mode & 0o077).toBe(0);
    expect(a.info.salt).not.toBe(b.info.salt);
    expect(a.bytes.equals(b.bytes)).toBe(false); // same key, same data: different ciphertext
    const input = path('in3');
    writeFileSync(input, plain);
    await expect(encryptFile(input, a.output, master)).rejects.toThrow(/EEXIST/); // refuses to replace an existing file
    expect(readFileSync(a.output).equals(a.bytes)).toBe(true); // ...and left it intact
  });

  it('removes a partial output when the input cannot be read', async () => {
    const output = path('enc');
    await expect(encryptFile(path('does-not-exist'), output, master)).rejects.toThrow();
    expect(existsSync(output)).toBe(false);
  });

  it('rejects a chunk size outside the supported range', async () => {
    const input = path('in');
    writeFileSync(input, 'x');
    for (const chunkLog2 of [5, 27, 1.5, Number.NaN]) await expect(encryptFile(input, path('enc'), master, { chunkLog2 })).rejects.toThrow(RangeError);
  });
});

describe('anything that is not exactly what was written is refused', () => {
  // 150 bytes in 64-byte chunks = 3 chunks (64, 64, 22).
  let fixture: { bytes: Buffer; key: Buffer };
  beforeAll(async () => {
    const { bytes, key } = await sealed(randomBytes(150), randomKey(), 6);
    fixture = { bytes, key };
    expect(await tryDecrypt(bytes, key)).toBe('ok'); // the control: the untouched file decrypts
  });

  it('refuses a flipped bit in ANY byte of the file (exhaustive)', async () => {
    const results = new Map<string, number>();
    for (let at = 0; at < fixture.bytes.length; at++) {
      const damaged = Buffer.from(fixture.bytes);
      damaged[at]! ^= 0x01;
      const code = await tryDecrypt(damaged, fixture.key);
      expect(code).not.toBe('ok'); // not one position is ignored
      results.set(code, (results.get(code) ?? 0) + 1);
    }
    expect(fixture.bytes.length).toBe(HEADER + 150 + 3 * TAG);
    // Header edits are caught as "not a backup"/"wrong key"; every other byte is caught by the chunk's authentication.
    expect(results.get('tampered')).toBeGreaterThan(150);
  });

  it('refuses every truncation, including at an exact chunk boundary and "header only"', async () => {
    for (let length = 0; length < fixture.bytes.length; length++) {
      expect(await tryDecrypt(fixture.bytes.subarray(0, length), fixture.key)).not.toBe('ok');
    }
    expect(await tryDecrypt(fixture.bytes.subarray(0, HEADER), fixture.key)).toBe('truncated');
    expect(await tryDecrypt(fixture.bytes.subarray(0, HEADER + 80), fixture.key)).toBe('tampered'); // dropped the last two chunks: the survivor is not marked final
  });

  it('refuses extra bytes after the end', async () => {
    for (const extra of [1, 2, 15, 16, 17, 80, 200]) {
      expect(await tryDecrypt(Buffer.concat([fixture.bytes, randomBytes(extra)]), fixture.key)).not.toBe('ok');
    }
  });

  it('refuses chunks that are reordered, repeated, or dropped', async () => {
    const header = fixture.bytes.subarray(0, HEADER);
    const chunk = (i: number) => fixture.bytes.subarray(HEADER + i * 80, i === 2 ? undefined : HEADER + (i + 1) * 80);
    const swapped = Buffer.concat([header, chunk(1), chunk(0), chunk(2)]);
    const repeated = Buffer.concat([header, chunk(0), chunk(1), chunk(1), chunk(2)]);
    const dropped = Buffer.concat([header, chunk(0), chunk(2)]);
    const firstOnly = Buffer.concat([header, chunk(0)]);
    for (const damaged of [swapped, repeated, dropped, firstOnly]) expect(await tryDecrypt(damaged, fixture.key)).toBe('tampered');
  });

  it('refuses a chunk moved in from ANOTHER backup made with the same key (the header is part of what is authenticated)', async () => {
    const donor = await sealed(randomBytes(150), fixture.key, 6);
    const grafted = Buffer.concat([fixture.bytes.subarray(0, HEADER + 80), donor.bytes.subarray(HEADER + 80)]);
    expect(await tryDecrypt(grafted, fixture.key)).toBe('tampered');
  });

  it('refuses the wrong key with a fixed message and no plaintext', async () => {
    expect(await tryDecrypt(fixture.bytes, randomKey())).toBe('wrong-key');
    expect(new BackupCryptoError('wrong-key').message).toBe('This backup was encrypted with a different key.');
  });

  it('refuses files that are not backups', async () => {
    for (const bytes of [Buffer.alloc(0), Buffer.from('PGDMP\u0001\u000e'), Buffer.from('Salted__' + 'x'.repeat(100)), randomBytes(200)]) {
      expect(await tryDecrypt(bytes, fixture.key)).toBe('not-a-backup');
    }
  });

  it('refuses a changed salt: the key derived for every chunk changes', async () => {
    const damaged = Buffer.from(fixture.bytes);
    damaged[10]! ^= 0xff; // a salt byte: the derived key changes, so every chunk fails
    expect(await tryDecrypt(damaged, fixture.key)).toBe('tampered');
  });
});

describe('known answer (an independent implementation wrote this file)', () => {
  // Produced by a separate implementation (Python `cryptography`: HKDF + AESGCM, written from the layout in backup-crypto.ts).
  // Key = bytes 0..31, salt = 0x10..0x1f, nonce prefix = 0xa0..0xa6, 64-byte chunks.
  const plain = 'Telesphoros backup known-answer test. '.repeat(6).slice(0, 150);
  const salt = Buffer.from(Array.from({ length: 16 }, (_, i) => 0x10 + i));
  const noncePrefix = Buffer.from(Array.from({ length: 7 }, (_, i) => 0xa0 + i));
  const golden =
    '5450424b0206101112131415161718191a1b1c1d1e1fa0a1a2a3a4a5a6e46548cf7823060a458fe0442bc490f2676b7e72539952a85096228696f1740e33be56e5443845ce809c787d007396df08ceabef8175454ac0ca022f0a024fe95aa7e496c2bca252a3525e79f8175a185bb4f387a159922d99b2769a9ee6e43f5dbf33aeb7be8e701ac907a63eaf9b529a98115ab9570ad0b54b8dcf4aac8b7213461d91f9b6a20f7a2311943e89a7fecd8f31be9f79e78e7dabf2295278119220d6d9a894193bdb4663bebcae83221618ed2c9b6a411a0395cbf829a9dacb7272c6e6eb768da54bbec1c4ccd5cd';

  it("produces exactly the independent implementation's bytes", async () => {
    const input = path('kat-in');
    const output = path('kat-out');
    writeFileSync(input, plain);
    await encryptFile(input, output, master, { chunkLog2: 6, salt, noncePrefix });
    expect(readFileSync(output).toString('hex')).toBe(golden);
    expect(keyIdHex(master)).toBe('e46548cf7823060a');
  });

  it("reads the independent implementation's file", async () => {
    const input = path('kat-file');
    const output = path('kat-plain');
    writeFileSync(input, Buffer.from(golden, 'hex'));
    await decryptFile(input, output, master);
    expect(readFileSync(output, 'utf8')).toBe(plain);
    expect(await readEncryptionHeader(input)).toEqual({ salt: salt.toString('hex'), keyId: 'e46548cf7823060a', chunkSize: 64 });
  });

  it('also opens with a decryptor written here from the layout alone (not the module under test)', () => {
    const file = Buffer.from(golden, 'hex');
    const header = file.subarray(0, HEADER);
    const key = Buffer.from(hkdfSync('sha256', master, header.subarray(6, 22), 'telesphoros-backup/enc/1', 32));
    let out = '';
    for (let i = 0, at = HEADER; at < file.length; i++, at += 80) {
      const piece = file.subarray(at, Math.min(at + 80, file.length));
      const last = at + 80 >= file.length;
      const nonce = Buffer.concat([header.subarray(22, 29), Buffer.from([0, 0, 0, i, last ? 1 : 0])]);
      const decipher = createDecipheriv('aes-256-gcm', key, nonce)
        .setAAD(header)
        .setAuthTag(piece.subarray(piece.length - TAG));
      out += Buffer.concat([decipher.update(piece.subarray(0, piece.length - TAG)), decipher.final()]).toString();
    }
    expect(out).toBe(plain);
  });
});

describe('the key file', () => {
  it('generates a random 64-hex key, owner-only, and refuses to overwrite it', async () => {
    const file = path('key');
    const { keyId } = await generateKeyFile(file);
    const text = readFileSync(file, 'utf8');
    expect(text).toMatch(/^[0-9a-f]{64}\n$/);
    expect(statSync(file).mode & 0o077).toBe(0);
    expect(keyId).toBe(keyIdHex(await readKeyFile(file)));
    await expect(generateKeyFile(file)).rejects.toThrow(/EEXIST/);
    expect(readFileSync(file, 'utf8')).toBe(text); // the first key is still there
    const second = path('key');
    await generateKeyFile(second);
    expect(readFileSync(second, 'utf8')).not.toBe(text);
  });

  it('accepts surrounding whitespace and upper-case hex, and rejects anything that is not a full random-looking key', async () => {
    const good = randomKey().toString('hex');
    const write = (content: string) => {
      const file = path('k');
      writeFileSync(file, content);
      return file;
    };
    expect((await readKeyFile(write(`  ${good.toUpperCase()}\r\n`))).toString('hex')).toBe(good);
    const bad = [
      '',
      '   ',
      'zz'.repeat(32),
      good.slice(2),
      `${good}00`,
      `${good}\n${good}`,
      '00'.repeat(32),
      'ff'.repeat(32),
      'ab'.repeat(32),
      '0123'.repeat(16),
      'hunter2hunter2hunter2',
    ];
    for (const content of bad) await expect(readKeyFile(write(content))).rejects.toMatchObject({ code: 'bad-key-file' });
    await expect(readKeyFile(path('absent'))).rejects.toThrow();
  });

  it('error text never contains key material', async () => {
    const good = randomKey().toString('hex');
    const file = path('k');
    writeFileSync(file, `${good}0`);
    await expect(readKeyFile(file)).rejects.toThrow(expect.objectContaining({ message: expect.not.stringContaining(good.slice(0, 8)) }));
  });
});

describe('the signed manifest', () => {
  const manifest = { formatVersion: 2, createdAt: '2026-01-01T00:00:00.000Z', tables: { b: { rows: 1 }, a: { rows: 2 } }, list: [3, 'x', null, true] };
  const saltHex = Buffer.from(Array.from({ length: 16 }, (_, i) => 0x10 + i)).toString('hex');

  it('canonical text sorts keys at every level and matches the independent implementation', () => {
    expect(stableStringify(manifest)).toBe('{"createdAt":"2026-01-01T00:00:00.000Z","formatVersion":2,"list":[3,"x",null,true],"tables":{"a":{"rows":2},"b":{"rows":1}}}');
    expect(stableStringify({ b: 1, a: 2 })).toBe(stableStringify({ a: 2, b: 1 })); // key order in the file never matters
  });

  it('computes the same MAC as the independent implementation (HMAC-SHA-256 under a separately derived key)', () => {
    expect(manifestMac(manifest, master, saltHex)).toBe('40c5ba836473e6ffd3ca328b456ec5e6a58a7e3941df96ca1c0537ae9e8d89a3');
  });

  it('verifies its own, and rejects every kind of change', () => {
    const signed = { ...manifest, mac: manifestMac(manifest, master, saltHex) };
    expect(verifyManifestMac(signed, master, saltHex)).toBe(true);
    expect(verifyManifestMac({ ...signed, tables: { ...manifest.tables, a: { rows: 3 } } }, master, saltHex)).toBe(false); // a value
    expect(verifyManifestMac({ ...signed, extra: 1 }, master, saltHex)).toBe(false); // an added field
    const { list: _removed, ...withoutList } = signed;
    void _removed;
    expect(verifyManifestMac(withoutList, master, saltHex)).toBe(false); // a removed field
    expect(verifyManifestMac(signed, randomKey(), saltHex)).toBe(false); // another key
    expect(verifyManifestMac(signed, master, 'ff'.repeat(16))).toBe(false); // another backup's salt
    for (const mac of [undefined, null, 5, '', 'zz', signed.mac.toUpperCase(), signed.mac.slice(2), `${signed.mac}00`]) {
      expect(verifyManifestMac({ ...manifest, mac }, master, saltHex)).toBe(false);
    }
    expect(verifyManifestMac(signed, master, 'not-hex')).toBe(false);
  });

  it('the manifest key is separate from the encryption key: a MAC cannot be forged from data the encryption key sees', () => {
    // The encryption key and the MAC key come from the same master and salt but different HKDF labels.
    const enc = Buffer.from(hkdfSync('sha256', master, Buffer.from(saltHex, 'hex'), 'telesphoros-backup/enc/1', 32));
    const mac = Buffer.from(hkdfSync('sha256', master, Buffer.from(saltHex, 'hex'), 'telesphoros-backup/manifest-mac/1', 32));
    expect(enc.equals(mac)).toBe(false);
  });
});
