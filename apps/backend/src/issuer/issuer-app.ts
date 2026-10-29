import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { CognitoTokenVerifier } from '../auth/cognito-token-verifier';
import { IssuerCore, JobIssuerCore, PgCapabilityIssueStore } from './issuer-core';
import type { IssuerConfig } from './issuer-env';
import { createIssuerServer, drainServer } from './issuer-server';

/**
 * Binds on every interface of the task. The Service Connect proxy reaches the application on the task's network interface (an assumption the Terraform
 * addendum records as unverified), and the container's own health check uses 127.0.0.1, which this covers. The security group admits one source.
 */
export const LISTEN_HOST = '0.0.0.0';

export interface RunningIssuer {
  port: number;
  /** Stops accepting, finishes requests in flight for up to `graceMs`, then closes the database pool. */
  stop(graceMs?: number): Promise<void>;
}

/**
 * Builds the issuer from its configuration: the real token verifier, the issuer login's own small pool, the core, and the HTTP server around it. Takes
 * the settings it is handed and reads nothing from the environment (a test pins that). `options` is for tests: a free port and a loopback address.
 */
export async function startIssuer(config: IssuerConfig, options: { host?: string; port?: number } = {}): Promise<RunningIssuer> {
  const verifier = new CognitoTokenVerifier({
    issuer: config.cognito.issuer,
    clientId: config.cognito.clientId,
    ...(config.cognito.jwksUri ? { jwksUri: config.cognito.jwksUri } : {}),
  });
  const store = new PgCapabilityIssueStore({ url: config.databaseUrl, ssl: config.databaseTls });
  // The job route exists only with a worker key (spec 012); the same pool serves both routes.
  const jobs = config.workerKey ? { key: config.workerKey, issuer: new JobIssuerCore(store) } : undefined;
  const server: Server = createIssuerServer(new IssuerCore(verifier, store), {}, jobs);
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(options.port ?? config.port, options.host ?? LISTEN_HOST, resolve);
    });
  } catch (error) {
    await store.close().catch(() => undefined);
    throw error;
  }
  return {
    port: (server.address() as AddressInfo).port,
    stop: async (graceMs = 20_000) => {
      await drainServer(server, graceMs);
      await store.close();
    },
  };
}
