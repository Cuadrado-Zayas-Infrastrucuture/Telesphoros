import { randomBytes } from 'node:crypto';
import { DecryptCommand, GenerateDataKeyCommand } from '@aws-sdk/client-kms';
import { createFieldKeyProvider, FieldKeyError, KmsFieldKeyProvider, LocalFieldKeyProvider } from './field-key-provider';

const context = { tenant: 'syn-tenant-1', patient: '11111111-1111-4111-8111-111111111111' };

describe('LocalFieldKeyProvider', () => {
  const provider = () => new LocalFieldKeyProvider(randomBytes(32).toString('hex'));

  it('wraps a random 256-bit data key and opens it with the same context', async () => {
    const p = provider();
    const { plaintext, wrapped } = await p.generateDataKey(context);
    expect(plaintext).toHaveLength(32);
    expect(wrapped.equals(plaintext)).toBe(false);
    expect(wrapped.includes(plaintext)).toBe(false); // the data key is not sitting inside its own wrapping
    expect((await p.unwrap(wrapped, context)).equals(plaintext)).toBe(true);
  });

  it('makes a different data key and a different wrapping each time', async () => {
    const p = provider();
    const a = await p.generateDataKey(context);
    const b = await p.generateDataKey(context);
    expect(a.plaintext.equals(b.plaintext)).toBe(false);
    expect(a.wrapped.equals(b.wrapped)).toBe(false);
  });

  it.each([
    ['another tenant', { ...context, tenant: 'syn-tenant-2' }],
    ['another patient', { ...context, patient: '22222222-2222-4222-8222-222222222222' }],
    ['the two swapped', { tenant: context.patient, patient: context.tenant }],
  ])('refuses to open a wrapped key under %s (the encryption context is enforced)', async (_label, wrong) => {
    const p = provider();
    const { wrapped } = await p.generateDataKey(context);
    await expect(p.unwrap(wrapped, wrong)).rejects.toMatchObject({ name: 'FieldKeyError', reason: 'unwrap-failed' });
  });

  it('positive control for the refusals above: the same bytes open under the right context', async () => {
    const p = provider();
    const { wrapped, plaintext } = await p.generateDataKey(context);
    await expect(p.unwrap(wrapped, { ...context, patient: 'other' })).rejects.toBeInstanceOf(FieldKeyError);
    expect((await p.unwrap(wrapped, context)).equals(plaintext)).toBe(true);
  });

  it('refuses a wrapped key made under another wrapping key, an altered one, and a truncated one', async () => {
    const p = provider();
    const { wrapped } = await p.generateDataKey(context);
    await expect(provider().unwrap(wrapped, context)).rejects.toMatchObject({ reason: 'unwrap-failed' });
    for (const index of [0, 5, 20, wrapped.length - 1]) {
      const altered = Buffer.from(wrapped);
      altered[index] = altered[index]! ^ 1;
      await expect(p.unwrap(altered, context)).rejects.toBeInstanceOf(FieldKeyError);
    }
    await expect(p.unwrap(wrapped.subarray(0, wrapped.length - 1), context)).rejects.toMatchObject({ reason: 'malformed' });
  });

  it('does not let a context be confused by moving a character between tenant and patient', async () => {
    const p = provider();
    const { wrapped } = await p.generateDataKey({ tenant: 'ab', patient: 'c' });
    await expect(p.unwrap(wrapped, { tenant: 'a', patient: 'bc' })).rejects.toBeInstanceOf(FieldKeyError);
  });

  it('rejects a wrapping key that is not 32 bytes', () => {
    expect(() => new LocalFieldKeyProvider('abcd')).toThrow(/32 bytes/);
  });

  it('error text is fixed: no key, context or provider message in it', async () => {
    const p = provider();
    const { wrapped } = await p.generateDataKey(context);
    const error = await p.unwrap(wrapped, { ...context, tenant: 'syn-leak-check' }).catch((e: Error) => e);
    expect((error as Error).message).toBe('A patient data key could not be opened.');
    expect(JSON.stringify(error)).not.toContain('syn-leak-check');
  });
});

describe('KmsFieldKeyProvider (the requests it sends; the real service is exercised against Moto in test/object-storage)', () => {
  const key = randomBytes(32);

  it('asks KMS for an AES_256 key under the configured key id, naming the encryption context', async () => {
    const send: jest.Mock = jest.fn().mockResolvedValue({ Plaintext: Uint8Array.from(key), CiphertextBlob: Uint8Array.from([1, 2, 3, 4]) });
    const provider = new KmsFieldKeyProvider({ send } as never, 'alias/synthetic-key');
    const out = await provider.generateDataKey(context);
    expect(out.plaintext.equals(key)).toBe(true);
    expect([...out.wrapped]).toEqual([1, 2, 3, 4]);
    const command = send.mock.calls[0]![0] as unknown as GenerateDataKeyCommand;
    expect(command).toBeInstanceOf(GenerateDataKeyCommand);
    expect(command.input).toEqual({ KeyId: 'alias/synthetic-key', KeySpec: 'AES_256', EncryptionContext: { tenant: context.tenant, patient: context.patient } });
  });

  it('decrypts with the same context AND the key id (a blob from another KMS key is refused)', async () => {
    const send: jest.Mock = jest.fn().mockResolvedValue({ Plaintext: Uint8Array.from(key) });
    const provider = new KmsFieldKeyProvider({ send } as never, 'alias/synthetic-key');
    expect((await provider.unwrap(Buffer.from([9, 9]), context)).equals(key)).toBe(true);
    const command = send.mock.calls[0]![0] as unknown as DecryptCommand;
    expect(command).toBeInstanceOf(DecryptCommand);
    expect(command.input).toMatchObject({ KeyId: 'alias/synthetic-key', EncryptionContext: { tenant: context.tenant, patient: context.patient } });
  });

  it('turns any KMS failure into a FieldKeyError that carries the error NAME only', async () => {
    const failing = new KmsFieldKeyProvider(
      { send: jest.fn().mockRejectedValue(Object.assign(new Error('synthetic provider detail'), { name: 'AccessDeniedException' })) } as never,
      'k',
    );
    const error = await failing.unwrap(Buffer.from([1]), context).catch((e: Error) => e);
    expect(error).toBeInstanceOf(FieldKeyError);
    expect((error as FieldKeyError).providerCode).toBe('AccessDeniedException');
    expect(JSON.stringify(error)).not.toContain('provider detail');
    expect((error as Error).message).not.toContain('provider detail');
    await expect(failing.generateDataKey(context)).rejects.toMatchObject({ reason: 'generate-failed', providerCode: 'AccessDeniedException' });
  });

  it('refuses a data key that is not 256 bits', async () => {
    const provider = new KmsFieldKeyProvider({ send: jest.fn(async () => ({ Plaintext: new Uint8Array(16), CiphertextBlob: new Uint8Array(4) })) } as never, 'k');
    await expect(provider.generateDataKey(context)).rejects.toMatchObject({ reason: 'generate-failed' });
    await expect(provider.unwrap(Buffer.from([1]), context)).rejects.toMatchObject({ reason: 'unwrap-failed' });
  });
});

describe('createFieldKeyProvider', () => {
  const base = { AWS_REGION: 'us-east-2' } as const;

  it('uses KMS when a key id is configured, and the local provider otherwise outside production', () => {
    expect(createFieldKeyProvider({ ...base, NODE_ENV: 'production', PATIENT_FIELD_KMS_KEY_ID: 'alias/synthetic-key' }).id).toBe('kms');
    expect(createFieldKeyProvider({ ...base, NODE_ENV: 'test' }).id).toBe('local');
    expect(createFieldKeyProvider({ ...base, NODE_ENV: 'development', PATIENT_FIELD_LOCAL_KEY: randomBytes(32).toString('hex') }).id).toBe('local');
  });

  it('refuses to build a local provider in production, with or without a key (the second lock behind env.ts)', () => {
    expect(() => createFieldKeyProvider({ ...base, NODE_ENV: 'production' })).toThrow(/refused in production/);
    expect(() => createFieldKeyProvider({ ...base, NODE_ENV: 'production', PATIENT_FIELD_LOCAL_KEY: randomBytes(32).toString('hex') })).toThrow(/refused in production/);
  });
});
