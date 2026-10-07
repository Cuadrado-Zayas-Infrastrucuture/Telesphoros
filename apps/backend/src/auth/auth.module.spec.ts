import { Test } from '@nestjs/testing';
import { ConfigModule } from '../config/config.module';
import { loadEnv } from '../config/env';
import { AuthModule } from './auth.module';
import { CognitoTokenVerifier } from './cognito-token-verifier';
import { HmacTokenVerifier, TokenVerifier } from './token-verifier';

// The e2e harness replaces the verifier, so THIS is what proves production wiring picks the right one.
async function verifierFor(source: Record<string, string>) {
  const module = await Test.createTestingModule({ imports: [ConfigModule.forRoot(loadEnv(source)), AuthModule] }).compile();
  return module.get(TokenVerifier);
}
const optionsOf = (verifier: unknown) => (verifier as { options: { issuer: string; clientId: string; jwksUri?: string } }).options;

describe('AuthModule picks the verifier from the environment', () => {
  it('hmac (development and tests) by default', async () => {
    expect(await verifierFor({ JWT_SECRET: 'x'.repeat(40) })).toBeInstanceOf(HmacTokenVerifier);
  });

  it('cognito: derives the issuer from region + pool id, and the client id from the settings', async () => {
    const verifier = await verifierFor({
      AUTH_VERIFIER: 'cognito', COGNITO_REGION: 'us-east-2', COGNITO_USER_POOL_ID: 'us-east-2_AbCdEf123', COGNITO_APP_CLIENT_ID: 'client-abc',
    });
    expect(verifier).toBeInstanceOf(CognitoTokenVerifier);
    expect(optionsOf(verifier)).toMatchObject({
      issuer: 'https://cognito-idp.us-east-2.amazonaws.com/us-east-2_AbCdEf123',
      clientId: 'client-abc',
      jwksUri: undefined, // the verifier then uses <issuer>/.well-known/jwks.json
    });
  });

  it('cognito with the development overrides (fake identity provider) uses them', async () => {
    const verifier = await verifierFor({
      AUTH_VERIFIER: 'cognito', COGNITO_APP_CLIENT_ID: 'c', COGNITO_ISSUER: 'http://127.0.0.1:4010', COGNITO_JWKS_URI: 'http://127.0.0.1:4010/keys',
    });
    expect(optionsOf(verifier)).toMatchObject({ issuer: 'http://127.0.0.1:4010', jwksUri: 'http://127.0.0.1:4010/keys', clientId: 'c' });
  });
});
