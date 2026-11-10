import { generateKeyPairSync, type KeyObject } from 'node:crypto';
import { parseSignerKeys, signingMessage, SignerKeysError } from './signatures';
import { signerKeysJson, TEST_SIGNERS } from '../../../test/helpers/knowledge';

const pem = (key: KeyObject) => key.export({ type: 'spki', format: 'pem' }).toString();

describe('the signed message', () => {
  it('is a fixed tag, the file id and the content hash, one per line', () => {
    expect(signingMessage('drugx-genea', 'a'.repeat(64)).toString('utf8')).toBe(`telesphoros-knowledge/1\ndrugx-genea\n${'a'.repeat(64)}`);
  });
});

describe('KNOWLEDGE_SIGNER_KEYS', () => {
  it('reads key id to P-256 public key, and nothing at all as an empty list', () => {
    expect([...parseSignerKeys(signerKeysJson()).keys()]).toEqual(TEST_SIGNERS.map((s) => s.keyId));
    expect(parseSignerKeys(undefined).size).toBe(0);
    expect(parseSignerKeys('  ').size).toBe(0);
  });

  it.each([
    ['not JSON', '{', 'not valid JSON'],
    ['an array', '[]', 'must be a JSON object'],
    ['a bad key id', JSON.stringify({ 'Signer A': pem(TEST_SIGNERS[0]!.publicKey) }), 'not a short lower-case id'],
    ['text that is not a key', JSON.stringify({ 'signer-a': 'secret-looking-text' }), 'the key for "signer-a" is not a PEM public key'],
    ['an RSA key', JSON.stringify({ 'signer-a': pem(generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey) }), 'is not a P-256 key'],
    ['a P-384 key', JSON.stringify({ 'signer-a': pem(generateKeyPairSync('ec', { namedCurve: 'secp384r1' }).publicKey) }), 'is not a P-256 key'],
    ['more than twenty signers', JSON.stringify(Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`signer-${i}`, pem(TEST_SIGNERS[0]!.publicKey)]))), 'more than 20'],
  ])('refuses %s, and the message never repeats what it was given', (_name, json, message) => {
    let thrown: unknown;
    try {
      parseSignerKeys(json);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(SignerKeysError);
    expect((thrown as Error).message).toContain(message);
    expect((thrown as Error).message).not.toContain('secret-looking-text');
    expect((thrown as Error).message).not.toContain('BEGIN PUBLIC KEY');
  });

  describe('two signers hold two keys', () => {
    const a = TEST_SIGNERS[0]!;
    /** The same public key written with its point compressed: other bytes, other PEM text, one key. */
    const compressedPem = (key: KeyObject, mirrored = false) => {
      const jwk = key.export({ format: 'jwk' });
      const x = Buffer.from(jwk.x!, 'base64url');
      // `mirrored` gives the other point with the same x: a different key that shares half its coordinates with this one.
      const odd = ((Buffer.from(jwk.y!, 'base64url').at(-1)! & 1) === 1) !== mirrored;
      const der = Buffer.concat([Buffer.from('3039301306072a8648ce3d020106082a8648ce3d030107032200', 'hex'), Buffer.from([odd ? 3 : 2]), x]);
      return `-----BEGIN PUBLIC KEY-----\n${der.toString('base64')}\n-----END PUBLIC KEY-----\n`;
    };

    it.each([
      ['the same PEM text', pem(a.publicKey)],
      ['the same key in another encoding', compressedPem(a.publicKey)],
      ['the private half of the same key', a.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()],
    ])('refuses two key ids that hold one key (%s), naming the ids and never the key', (name, second) => {
      expect(second === pem(a.publicKey)).toBe(name === 'the same PEM text'); // the other two cases really are different text
      let thrown: unknown;
      try {
        parseSignerKeys(JSON.stringify({ 'signer-a': pem(a.publicKey), 'signer-b': second }));
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(SignerKeysError);
      expect((thrown as Error).message).toBe('KNOWLEDGE_SIGNER_KEYS: "signer-a" and "signer-b" hold the same key. Each signer needs a key of their own.');
      expect((thrown as Error).message).not.toContain('BEGIN');
    });

    it('control: two different keys are two signers, whatever their encoding', () => {
      expect(parseSignerKeys(JSON.stringify({ 'signer-a': pem(a.publicKey), 'signer-b': compressedPem(TEST_SIGNERS[1]!.publicKey) })).size).toBe(2);
      // The whole point is compared: a key that shares only its x coordinate with another is a different key.
      expect(parseSignerKeys(JSON.stringify({ 'signer-a': pem(a.publicKey), 'signer-b': compressedPem(a.publicKey, true) })).size).toBe(2);
    });
  });
});
