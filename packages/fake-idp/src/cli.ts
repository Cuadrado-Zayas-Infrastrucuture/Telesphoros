#!/usr/bin/env node
/** Runs the fake identity provider as a standalone process (used by the browser tests). TEST ONLY. */
import { startFakeIdp } from './index';

function arg(name: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}
const all = (name: string) => process.argv.flatMap((value, index) => (value === `--${name}` && process.argv[index + 1] ? [process.argv[index + 1]!] : []));

const idp = await startFakeIdp({
  port: Number(arg('port', '4010')),
  clientId: arg('client-id', 'fake-client-id'),
  redirectUris: all('redirect-uri'),
  logoutUris: all('logout-uri'),
});
process.stdout.write(`fake-idp (TEST ONLY) listening on ${idp.issuer}\n`);
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => void idp.stop().then(() => process.exit(0)));
