import type { RouteObject } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Spec 019 D02a, T008: the acknowledgements test page has a route in the e2e build alone. The production build is checked on its output by
// scripts/check-chunks.mjs (the route path) and scripts/check-foundation.mjs (the chunk); this checks the route table each mode builds.
const PATH = 'e2e/result-acknowledgements';
const paths = (routes: RouteObject[]): string[] => routes.flatMap((r) => [...(r.path ? [r.path] : []), ...paths(r.children ?? [])]);

async function routesIn(mode: string) {
  vi.resetModules();
  vi.stubEnv('MODE', mode);
  return (await import('./routes')).routes;
}

describe('the test-only acknowledgements route', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('exists in the e2e mode (the control), and in no other', async () => {
    expect(paths(await routesIn('e2e'))).toContain(PATH);
    for (const mode of ['production', 'development', 'test']) expect(paths(await routesIn(mode))).not.toContain(PATH);
  });
});
