import { Test } from '@nestjs/testing';
import { ConfigModule } from '../config/config.module';
import { loadEnv } from '../config/env';
import { StorageModule } from '../storage/storage.module';
import { InMemoryMembershipRepository, type MembershipRepository } from '../storage/membership.repository';
import { CapabilityIssuerPort, NullCapabilityIssuer } from '../issuer/capability-issuer.port';
import { HttpCapabilityIssuer } from '../issuer/issuer-http-client';
import { AuthModule, createApplicationVerifier, createCapabilityIssuer } from './auth.module';
import { CognitoTokenVerifier } from './cognito-token-verifier';
import { MirrorTokenVerifier } from './mirror-token-verifier';
import { HmacTokenVerifier, TokenVerifier } from './token-verifier';

// The e2e harness replaces the verifier, so THIS is what proves production wiring picks the right one.
async function wiredVerifier(source: Record<string, string>) {
  const env = loadEnv(source);
  const module = await Test.createTestingModule({ imports: [ConfigModule.forRoot(env), StorageModule.register(env), AuthModule] }).compile();
  return module.get(TokenVerifier);
}
/** The identity verifier, whether or not the development mirror wraps it. */
const unwrap = (verifier: TokenVerifier): TokenVerifier => (verifier instanceof MirrorTokenVerifier ? (verifier as unknown as { inner: TokenVerifier }).inner : verifier);
async function verifierFor(source: Record<string, string>) {
  return unwrap(await wiredVerifier(source));
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

  it('the in-memory development store mirrors the token into membership; PostgreSQL (and so production) never does', async () => {
    expect(await wiredVerifier({ JWT_SECRET: 'x'.repeat(40) })).toBeInstanceOf(MirrorTokenVerifier);
    const postgres = loadEnv({ JWT_SECRET: 'x'.repeat(40), STORAGE_DRIVER: 'postgres', DATABASE_URL: 'postgres://app@127.0.0.1:1/none' });
    const database = createApplicationVerifier(postgres, { find: async () => undefined } as MembershipRepository);
    expect(database).toBeInstanceOf(HmacTokenVerifier);
    expect(database).not.toBeInstanceOf(MirrorTokenVerifier);
  });

  it('refuses to mirror anywhere but the in-memory store, even if the wiring is misconfigured', () => {
    const memory = loadEnv({ JWT_SECRET: 'x'.repeat(40) });
    expect(() => createApplicationVerifier(memory, { find: async () => undefined } as MembershipRepository)).toThrow(/in-memory development store only/);
    expect(createApplicationVerifier(memory, new InMemoryMembershipRepository())).toBeInstanceOf(MirrorTokenVerifier);
    // loadEnv already refuses the in-memory store when NODE_ENV=production; the factory refuses it too, independently.
    expect(() => createApplicationVerifier({ ...memory, NODE_ENV: 'production' }, new InMemoryMembershipRepository())).toThrow(/in-memory development store only/);
  });
});

describe('AuthModule picks the capability issuer from the environment', () => {
  async function wiredIssuer(source: Record<string, string>) {
    const env = loadEnv(source);
    const module = await Test.createTestingModule({ imports: [ConfigModule.forRoot(env), StorageModule.register(env), AuthModule] }).compile();
    return module.get(CapabilityIssuerPort);
  }
  const hmac = { JWT_SECRET: 'x'.repeat(40) };

  it('no ISSUER_URL: no issuer is asked, exactly as before this setting existed', async () => {
    expect(await wiredIssuer(hmac)).toBeInstanceOf(NullCapabilityIssuer);
    expect(createCapabilityIssuer(loadEnv(hmac))).toBeInstanceOf(NullCapabilityIssuer);
  });

  it('with ISSUER_URL the application\'s port is the HTTP client, built from that address', async () => {
    const issuer = await wiredIssuer({ ...hmac, ISSUER_URL: 'http://127.0.0.1:41234' });
    expect(issuer).toBeInstanceOf(HttpCapabilityIssuer);
    expect(issuer).not.toBeInstanceOf(NullCapabilityIssuer);
    expect((issuer as unknown as { endpoint: string }).endpoint).toBe('http://127.0.0.1:41234/v1/capabilities');
  });
});
