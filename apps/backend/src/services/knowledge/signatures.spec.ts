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
});
