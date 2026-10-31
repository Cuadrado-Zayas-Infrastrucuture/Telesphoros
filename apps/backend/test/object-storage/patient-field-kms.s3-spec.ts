import { randomBytes } from 'node:crypto';
import { CreateKeyCommand, DecryptCommand, GenerateDataKeyCommand, KMSClient } from '@aws-sdk/client-kms';
import { FieldKeyError, KmsFieldKeyProvider } from '../../src/patient-demographics/field-key-provider';
import { openField, sealField } from '../../src/patient-demographics/identity-crypto';

// Runs against an AWS-compatible emulator (Moto), selected by TEST_S3_ENDPOINT (the same server the S3 specs use; this spec starts none of its own).
// It makes its own KMS keys, so nothing here depends on, or touches, another spec's. The emulator does not verify signatures or IAM: what is proved here is that
// the encryption context is part of the key's answer, which is the property the provider relies on (PD-3); IAM conditions on the context are slice PD-b.
const endpoint = process.env.TEST_S3_ENDPOINT!;
let client: KMSClient;
let keyId: string;
let otherKeyId: string;
let provider: KmsFieldKeyProvider;

const context = { tenant: 'syn-tenant-1', patient: '11111111-1111-4111-8111-111111111111' };

beforeAll(async () => {
  // Explicit emulator credentials: the default provider chain would read whatever profile the developer's shell names, and this spec talks to localhost only.
  client = new KMSClient({ region: 'us-east-1', endpoint, credentials: { accessKeyId: 'local-test', secretAccessKey: 'local-test' } });
  keyId = (await client.send(new CreateKeyCommand({ Description: 'synthetic patient field key' }))).KeyMetadata!.KeyId!;
  otherKeyId = (await client.send(new CreateKeyCommand({ Description: 'another synthetic key' }))).KeyMetadata!.KeyId!;
  provider = new KmsFieldKeyProvider(client, keyId);
});
afterAll(() => client.destroy());

describe('KmsFieldKeyProvider against an emulator', () => {
  it('generates a 256-bit data key, wraps it, and opens it again under the same encryption context', async () => {
    const { plaintext, wrapped } = await provider.generateDataKey(context);
    expect(plaintext).toHaveLength(32);
    expect(wrapped.length).toBeGreaterThan(32);
    expect(wrapped.includes(plaintext)).toBe(false);
    expect((await provider.unwrap(wrapped, context)).equals(plaintext)).toBe(true);
  });

  it('end to end: a field sealed under the data key opens after the key is unwrapped from KMS, and not for another patient', async () => {
    const binding = { tenant: context.tenant, patient: context.patient, keyVersion: 1 };
    const { plaintext, wrapped } = await provider.generateDataKey(context);
    const sealed = sealField(plaintext, binding, 'given_name', 'Synthetic-Kms-Given');
    const reopened = await provider.unwrap(wrapped, context);
    expect(openField(reopened, binding, 'given_name', sealed)).toBe('Synthetic-Kms-Given');
    await expect(provider.unwrap(wrapped, { ...context, patient: '22222222-2222-4222-8222-222222222222' })).rejects.toBeInstanceOf(FieldKeyError);
  });

  it.each([
    ['another patient', { ...context, patient: '22222222-2222-4222-8222-222222222222' }],
    ['another tenant', { ...context, tenant: 'syn-tenant-2' }],
  ])('refuses to unwrap under %s: a wrong encryption context fails in KMS', async (_label, wrong) => {
    const { wrapped } = await provider.generateDataKey(context);
    const error = await provider.unwrap(wrapped, wrong).catch((e: Error) => e);
    expect(error).toBeInstanceOf(FieldKeyError);
    expect((error as FieldKeyError).reason).toBe('unwrap-failed');
    expect((error as FieldKeyError).providerCode).toBeDefined(); // KMS's own refusal, not a local check
  });

  it('control for the refusal: the emulator itself refuses a Decrypt with a wrong or missing context (provider bypassed), and opens it with the right one', async () => {
    const { CiphertextBlob, Plaintext } = await client.send(
      new GenerateDataKeyCommand({ KeyId: keyId, KeySpec: 'AES_256', EncryptionContext: { tenant: context.tenant, patient: context.patient } }),
    );
    const decrypt = (EncryptionContext?: Record<string, string>) =>
      client.send(new DecryptCommand({ CiphertextBlob, KeyId: keyId, ...(EncryptionContext ? { EncryptionContext } : {}) }));
    await expect(decrypt()).rejects.toBeDefined(); // a Decrypt WITHOUT the context fails
    await expect(decrypt({ tenant: context.tenant, patient: 'someone-else' })).rejects.toBeDefined();
    const ok = await decrypt({ tenant: context.tenant, patient: context.patient });
    expect(Buffer.from(ok.Plaintext!).equals(Buffer.from(Plaintext!))).toBe(true);
  });

  it('refuses a wrapped key that another KMS key made (the key id is named on Decrypt)', async () => {
    const foreign = new KmsFieldKeyProvider(client, otherKeyId);
    const { wrapped } = await foreign.generateDataKey(context);
    await expect(provider.unwrap(wrapped, context)).rejects.toBeInstanceOf(FieldKeyError);
    expect((await foreign.unwrap(wrapped, context)).length).toBe(32); // control: its own key opens it
  });

  it('refuses garbage bytes', async () => {
    await expect(provider.unwrap(randomBytes(64), context)).rejects.toBeInstanceOf(FieldKeyError);
  });
});
