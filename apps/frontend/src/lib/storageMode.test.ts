import { afterEach, expect, it, vi } from 'vitest';
import { ownedStorageMode, syntheticStagingMode } from './storageMode';

afterEach(() => vi.unstubAllEnvs());

it.each([
  [undefined, false],
  ['', false],
  ['false', false],
  ['true', true],
])('reads the synthetic staging build flag %j as %s', (setting, expected) => {
  if (setting !== undefined) vi.stubEnv('VITE_SYNTHETIC_ASSESSMENT', setting);
  expect(syntheticStagingMode()).toBe(expected);
});

it.each(['yes', '1', 'TRUE', ' true'])('refuses a value that is not true or false (%j), rather than taking it for off', (setting) => {
  vi.stubEnv('VITE_SYNTHETIC_ASSESSMENT', setting);
  expect(() => syntheticStagingMode()).toThrow('Invalid synthetic assessment setting.');
});

it('refuses to be the owned-local build as well (control: each alone is accepted)', () => {
  vi.stubEnv('VITE_SYNTHETIC_ASSESSMENT', 'true');
  expect(syntheticStagingMode()).toBe(true);
  vi.unstubAllEnvs();
  vi.stubEnv('VITE_LOCAL_STORAGE_INTAKE', 'true');
  expect(ownedStorageMode()).toBe(true);
  vi.stubEnv('VITE_SYNTHETIC_ASSESSMENT', 'true');
  expect(() => syntheticStagingMode()).toThrow('cannot also be the owned-local build');
});
