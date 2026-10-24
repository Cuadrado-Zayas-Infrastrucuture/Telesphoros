import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// main.ts is not started by any test, so a wiring slip there would be silent. These read its text and pin the two settings that
// change what the API does behind a load balancer. (Reads text; it cannot prove what the running server does.)
const main = readFileSync(join(__dirname, 'main.ts'), 'utf8');
const call = /configureApp\(app,\s*\{([^}]*)\}\)/.exec(main)?.[1] ?? '';

describe('main.ts wiring', () => {
  it('finds the configureApp call (a floor, so an empty scan cannot pass)', () => {
    expect(call.length).toBeGreaterThan(10);
  });

  it('passes the configured number of trusted proxies, so the per-address rate limit sees the real client', () => {
    expect(call).toMatch(/trustProxyHops:\s*env\.TRUST_PROXY_HOPS\b/);
  });

  it('passes the configured CORS origins', () => {
    expect(call).toMatch(/corsOrigins:\s*env\.CORS_ALLOWED_ORIGINS\b/);
  });

  it('installs the process fault handlers before anything else runs', () => {
    const install = main.indexOf("installProcessFaultHandlers(process, { service: 'api' })");
    expect(install).toBeGreaterThan(-1);
    expect(install).toBeLessThan(main.indexOf('async function bootstrap'));
    expect(main).toMatch(/import \{ installProcessFaultHandlers \} from '\.\/common\/process-faults'/);
  });

  it('stops through installGracefulShutdown after the listener is up, and no longer through Nest\'s own shutdown hooks', () => {
    expect(main).toMatch(/import \{ installGracefulShutdown \} from '\.\/common\/graceful-shutdown'/);
    expect(main.indexOf('installGracefulShutdown(app,')).toBeGreaterThan(main.indexOf('await app.listen('));
    expect(main).not.toMatch(/enableShutdownHooks\(\)\s*;/); // the comment that explains the absence does not call it with a semicolon
  });

  it('detects a missing setting (control: the pattern fails on a call that leaves it out)', () => {
    expect(/trustProxyHops:\s*env\.TRUST_PROXY_HOPS\b/.test('configureApp(app, { corsOrigins: env.CORS_ALLOWED_ORIGINS })')).toBe(false);
  });
});
