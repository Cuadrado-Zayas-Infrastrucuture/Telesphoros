import { afterEach, expect, it, vi } from 'vitest';
import type { RouteObject } from 'react-router-dom';
const paths = (routes: RouteObject[]): string[] => routes.flatMap(route => [...(route.path ? [route.path] : []), ...paths(route.children ?? [])]);
afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });

it.each([undefined, 'false', 'true'])('keeps reports behind the existing owned-storage setting %s', async setting => {
  vi.resetModules(); vi.stubEnv('VITE_LOCAL_STORAGE_INTAKE', setting);
  const { routes } = await import('./routes');
  expect(paths(routes).includes('reports')).toBe(setting === 'true');
});
it('refuses an invalid storage setting instead of broadening access', async () => {
  vi.resetModules(); vi.stubEnv('VITE_LOCAL_STORAGE_INTAKE', 'invalid');
  await expect(import('./routes')).rejects.toThrow('Invalid local storage intake setting');
});

it.each([false, true])('only registers the interpretation preview in development (%s)', async dev => {
  vi.resetModules(); vi.stubEnv('DEV', dev);
  const { routes } = await import('./routes');
  expect(paths(routes).includes('local-interpretation')).toBe(dev);
});
