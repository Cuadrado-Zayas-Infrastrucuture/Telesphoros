import fs from 'node:fs';
import { vi, test, expect } from 'vitest';
test('refuses production startup before reading runtime credentials', async () => {
  const exitCode = process.exitCode;
  vi.stubEnv('NODE_ENV', 'production');
  const read = vi.spyOn(fs, 'readFileSync');
  const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  try {
    await import('../src/start.js');
    await vi.waitFor(() => expect(process.exitCode).toBe(1));
    expect(read.mock.calls.some(([name]) => String(name).includes('.runtime/registration.json'))).toBe(false);
    expect(stderr).toHaveBeenCalledWith('Pilot startup failed; verify build, registration and local ports.\n');
  } finally {
    process.exitCode = exitCode;
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  }
});
