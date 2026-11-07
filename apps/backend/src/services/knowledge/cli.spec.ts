import { join } from 'node:path';
import { contentSha256 } from './content-hash';
import { runKnowledgeCli } from './cli';
import { cleanupTempDirs, readJson, REAL_KNOWLEDGE_DIR, reviewedCopyOf, signerKeysJson, SYNTHETIC_DIR, tempDir, TEST_SIGNERS, writeJson } from '../../../test/helpers/knowledge';
import { GetPublicKeyCommand, SignCommand } from '@aws-sdk/client-kms';
import { generateKeyPairSync, sign as signRaw, type KeyObject } from 'node:crypto';
import { checkSignatures, parseSignerKeys } from './signatures';
import { writeFile } from 'node:fs/promises';

afterAll(cleanupTempDirs);

async function run(args: string[], env: NodeJS.ProcessEnv = {}, deps?: Parameters<typeof runKnowledgeCli>[3]) {
  const lines: string[] = [];
  const code = await runKnowledgeCli(args, (line) => lines.push(line), env, deps);
  return { code, text: lines.join('\n') };
}

describe('knowledge CLI', () => {
  it('verify passes for the fixtures outside production, and fails for them in production', async () => {
    const ok = await run(['verify', '--dir', SYNTHETIC_DIR]);
    expect(ok.code).toBe(0);
    expect(ok.text).toMatch(/^OK \(non-production\): 11 files, 6 guidelines, knowledge set [0-9a-f]{64}/);
    const refused = await run(['verify', '--dir', SYNTHETIC_DIR, '--production']);
    expect(refused.code).toBe(1);
    expect(refused.text).toContain('not allowed in production');
  });

  it('verify passes for the knowledge directory that ships, in production, and says when it is empty', async () => {
    const result = await run(['verify', '--production'], { KNOWLEDGE_DIR: REAL_KNOWLEDGE_DIR });
    expect(result.code).toBe(0);
    expect(result.text).toContain('no guidelines are loaded');
  });

  it('hash prints exactly the hash the loader checks', async () => {
    const path = join(SYNTHETIC_DIR, 'guidelines/drugx-genea.json');
    const result = await run(['hash', path]);
    expect(result).toEqual({ code: 0, text: contentSha256(await readJson(path)) });
  });

  it('hash refuses to prepare a signature for real content whose license or redistribution is "unknown"', async () => {
    const dir = await tempDir();
    const source = (await readJson(join(SYNTHETIC_DIR, 'guidelines/drugx-genea.json'))) as unknown as { synthetic: boolean; provenance: Record<string, string> };
    for (const [field, value] of [
      ['license', 'cc0-1.0'],
      ['redistribution', 'allowed'],
    ] as const) {
      const real = { ...source, synthetic: false, provenance: { ...source.provenance, license: 'cc0-1.0', redistribution: 'allowed', [field]: 'unknown' } };
      const path = join(dir, `${field}.json`);
      await writeFile(path, JSON.stringify(real));
      const refused = await run(['hash', path]);
      expect([field, refused.code]).toEqual([field, 1]);
      expect(refused.text).toContain('Not ready to sign');
      expect(refused.text).not.toMatch(/^[0-9a-f]{64}$/);
      // control: stating the value makes the same file hashable
      await writeFile(path, JSON.stringify({ ...real, provenance: { ...real.provenance, [field]: value } }));
      expect([`${field} stated`, (await run(['hash', path])).code]).toEqual([`${field} stated`, 0]);
    }
  });

  it('hash still prints a hash for synthetic content with "unknown" fields (it can never be signed)', async () => {
    const dir = await tempDir();
    const source = (await readJson(join(SYNTHETIC_DIR, 'guidelines/drugx-genea.json'))) as unknown as { provenance: Record<string, string> };
    const path = join(dir, 'synthetic.json');
    await writeFile(path, JSON.stringify({ ...source, provenance: { ...source.provenance, license: 'unknown', redistribution: 'unknown' } }));
    expect((await run(['hash', path])).code).toBe(0);
  });

  it('hash refuses a file that is not a knowledge file, and reports a bad path without a stack trace', async () => {
    const dir = await tempDir();
    await writeFile(join(dir, 'x.json'), '{"nope":true}');
    expect((await run(['hash', join(dir, 'x.json')])).code).toBe(1);
    const missing = await run(['hash', join(dir, 'missing.json')]);
    expect(missing.code).toBe(1);
    expect(missing.text).not.toMatch(/at |ENOENT|Error:/);
  });

  it('prints usage for anything else', async () => {
    expect((await run([])).code).toBe(2);
    expect((await run(['sign'])).code).toBe(2);
    expect((await run(['hash'])).code).toBe(2);
  });
});

// Audit CLIN-01: production checks two signatures against KNOWLEDGE_SIGNER_KEYS, and `sign` makes one through KMS. KMS is a stub here that signs with a
// key generated for the test: nothing calls AWS.
describe('knowledge CLI: signatures', () => {
  const stubKms = (signWith: KeyObject, publicKey: KeyObject, fail = false) => ({
    send: async (command: unknown) => {
      if (fail) throw new Error('AccessDeniedException: arn:aws:kms:us-east-1:111122223333:key/secret-detail');
      if (command instanceof SignCommand) {
        expect(command.input).toMatchObject({ MessageType: 'RAW', SigningAlgorithm: 'ECDSA_SHA_256', KeyId: 'arn:aws:kms:us-east-1:111122223333:key/k' });
        return { Signature: signRaw('sha256', Buffer.from(command.input.Message!), { key: signWith, dsaEncoding: 'der' }) };
      }
      if (command instanceof GetPublicKeyCommand) return { PublicKey: publicKey.export({ type: 'spki', format: 'der' }) };
      throw new Error('unexpected command');
    },
  });
  const signArgs = (path: string) => ['sign', path, '--key-id', 'test-signer-a', '--kms-key', 'arn:aws:kms:us-east-1:111122223333:key/k'];

  it('verify --production reads the signer keys from KNOWLEDGE_SIGNER_KEYS, and refuses the same files without them', async () => {
    const dir = await reviewedCopyOf(SYNTHETIC_DIR);
    expect((await run(['verify', '--dir', dir, '--production'], { KNOWLEDGE_SIGNER_KEYS: signerKeysJson() })).code).toBe(0);
    const refused = await run(['verify', '--dir', dir, '--production']);
    expect(refused.code).toBe(1);
    expect(refused.text).toContain('no signer keys are configured');
    expect(await run(['verify', '--dir', dir, '--production'], { KNOWLEDGE_SIGNER_KEYS: '{' })).toEqual({ code: 1, text: 'KNOWLEDGE_SIGNER_KEYS is not valid JSON.' });
  });

  it('sign prints a signature entry that the loader accepts for that file', async () => {
    const dir = await reviewedCopyOf(SYNTHETIC_DIR, undefined, { signers: [TEST_SIGNERS[1]!] });
    const path = join(dir, 'guidelines/drugx-genea.json');
    const signer = TEST_SIGNERS[0]!;
    const result = await run(signArgs(path), {}, { kms: () => stubKms(signer.privateKey, signer.publicKey) });
    expect(result.code).toBe(0);
    const entry = JSON.parse(result.text);
    expect(entry).toMatchObject({ keyId: 'test-signer-a', algorithm: 'ecdsa-p256-sha256' });
    const file = await readJson(path);
    if (file.review.status === 'reviewed') file.review.signatures = [...(file.review.signatures ?? []), entry];
    await writeJson(path, file);
    expect(checkSignatures('f', file, contentSha256(file), parseSignerKeys(signerKeysJson()))).toEqual({ problems: [], signedBy: ['test-signer-a', 'test-signer-b'] });
  });

  it("refuses a KMS signature that does not verify against the key's own public key, and never repeats a KMS error", async () => {
    const path = join(await reviewedCopyOf(SYNTHETIC_DIR), 'guidelines/drugx-genea.json');
    const other = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const mismatch = await run(signArgs(path), {}, { kms: () => stubKms(TEST_SIGNERS[0]!.privateKey, other.publicKey) });
    expect(mismatch).toEqual({ code: 1, text: "KMS returned a signature that does not verify against the key's own public key. Nothing to paste." });
    const failed = await run(signArgs(path), {}, { kms: () => stubKms(TEST_SIGNERS[0]!.privateKey, TEST_SIGNERS[0]!.publicKey, true) });
    expect(failed).toEqual({ code: 1, text: 'KMS could not sign (check the key ARN, its key spec ECC_NIST_P256, and your AWS credentials).' });
  });

  it('refuses to sign synthetic content, and asks for both flags', async () => {
    const synthetic = join(SYNTHETIC_DIR, 'guidelines/drugx-genea.json');
    const signer = TEST_SIGNERS[0]!;
    expect(await run(signArgs(synthetic), {}, { kms: () => stubKms(signer.privateKey, signer.publicKey) })).toEqual({ code: 1, text: 'Synthetic content can never be signed.' });
    expect((await run(['sign', synthetic, '--key-id', 'test-signer-a'])).code).toBe(2);
  });
});
