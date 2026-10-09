import { randomBytes } from 'node:crypto';
import { CreateSecretCommand, DeleteSecretCommand, GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { secretsManagerStore } from '../../src/db/provision-secrets';
import { S3_ENDPOINT } from '../helpers/offsite-fixtures';

/**
 * The Secrets Manager side of `provision-logins` against an emulator (moto serves Secrets Manager on the same endpoint as S3). It proves the three behaviours the
 * command relies on: an empty container reads as "no value yet", a put is readable, and a second put replaces the first. IAM is NOT emulated; the real permissions
 * are in Terraform and unproven until a real account exists.
 */
const client = new SecretsManagerClient({ region: 'us-east-2', endpoint: S3_ENDPOINT, credentials: { accessKeyId: 'test', secretAccessKey: 'test' } });
const created: string[] = [];
const newName = () => {
  const name = `telesphoros-test/${randomBytes(5).toString('hex')}/database-url`;
  created.push(name);
  return name;
};

afterAll(async () => {
  for (const name of created) await client.send(new DeleteSecretCommand({ SecretId: name, ForceDeleteWithoutRecovery: true })).catch(() => undefined);
});

describe('secretsManagerStore', () => {
  it('reads an empty container as "no value yet" (not an error)', async () => {
    const name = newName();
    await client.send(new CreateSecretCommand({ Name: name, Description: 'container only' }));
    await expect(secretsManagerStore(client).get(name)).resolves.toBeUndefined();
  });

  it('writes a value that can be read back, and a second write replaces it', async () => {
    const name = newName();
    await client.send(new CreateSecretCommand({ Name: name }));
    const store = secretsManagerStore(client);
    await store.put(name, 'postgres://u:first@h:5432/d');
    await expect(store.get(name)).resolves.toBe('postgres://u:first@h:5432/d');
    await store.put(name, 'postgres://u:second@h:5432/d');
    await expect(store.get(name)).resolves.toBe('postgres://u:second@h:5432/d');
    const direct = await client.send(new GetSecretValueCommand({ SecretId: name })); // control: the emulator holds the same current value
    expect(direct.SecretString).toBe('postgres://u:second@h:5432/d');
  });

  it('a secret that does not exist cannot be written: the command stops with a clear message before it touches the database', async () => {
    const name = `telesphoros-test/${randomBytes(5).toString('hex')}/missing`;
    const store = secretsManagerStore(client);
    await expect(store.get(name)).resolves.toBeUndefined(); // reads the same as an empty container (the service answers "not found" for both) ...
    await expect(store.put(name, 'x')).rejects.toThrow(/does not exist/); // ... which is why the write is where a wrong id is caught
  });
});
