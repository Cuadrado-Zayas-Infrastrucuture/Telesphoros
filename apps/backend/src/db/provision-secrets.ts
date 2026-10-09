import { GetSecretValueCommand, PutSecretValueCommand, ResourceNotFoundException, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import type { SecretStore } from './provision-logins';

/**
 * The AWS Secrets Manager implementation of the secret store used by `provision-logins`. It reads and writes exactly the secret ids it is given (the three
 * containers Terraform creates, api-compute.tf) and nothing else. Values never pass through a log line, an error message or a return value other than `get`.
 */
export function secretsManagerStore(client: SecretsManagerClient = new SecretsManagerClient({})): SecretStore {
  return {
    async get(id) {
      try {
        const result = await client.send(new GetSecretValueCommand({ SecretId: id }));
        return result.SecretString || undefined;
      } catch (error) {
        // A container with no value yet answers "not found" for the current version; that is the empty state, not a failure. (A wrong id answers the same; see put.)
        if (error instanceof ResourceNotFoundException) return undefined;
        throw error;
      }
    },
    async put(id, value) {
      try {
        await client.send(new PutSecretValueCommand({ SecretId: id, SecretString: value }));
      } catch (error) {
        // `get` cannot tell a container with no value from an id that names nothing (both are "not found"), so a wrong id surfaces HERE, before the database is touched.
        if (error instanceof ResourceNotFoundException) throw new Error(`The secret ${id} does not exist: Terraform creates the three containers (api-compute.tf); check the id.`, { cause: error });
        throw error;
      }
    },
  };
}
