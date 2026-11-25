import { afterEach, expect, it, vi } from 'vitest';
import { languagePreviewEnabled } from './languagePreview';

// Spec 050 LS2-D1: the founders' preview is a build-time opt-in for development, test and e2e builds only; any other build refuses it at start-up.

afterEach(() => vi.unstubAllEnvs());

it('is off when the flag is unset, empty or false, in any build', () => {
  for (const mode of ['development', 'e2e', 'production']) expect(languagePreviewEnabled(mode)).toBe(false);
  vi.stubEnv('VITE_LANGUAGE_PREVIEW', '');
  expect(languagePreviewEnabled('production')).toBe(false);
  vi.stubEnv('VITE_LANGUAGE_PREVIEW', 'false');
  expect(languagePreviewEnabled('production')).toBe(false);
});

it('is on with the flag in a development, test or e2e build', () => {
  vi.stubEnv('VITE_LANGUAGE_PREVIEW', 'true');
  for (const mode of ['development', 'test', 'e2e']) expect(languagePreviewEnabled(mode)).toBe(true);
});

it('is refused with the flag in a production, staging or any other build', () => {
  vi.stubEnv('VITE_LANGUAGE_PREVIEW', 'true');
  for (const mode of ['production', 'staging', 'e2e-storage', '']) expect(() => languagePreviewEnabled(mode)).toThrow(/development, test and e2e builds only/);
});

it('refuses a value that is not true or false', () => {
  vi.stubEnv('VITE_LANGUAGE_PREVIEW', 'yes');
  expect(() => languagePreviewEnabled('development')).toThrow('Invalid language preview setting.');
});
