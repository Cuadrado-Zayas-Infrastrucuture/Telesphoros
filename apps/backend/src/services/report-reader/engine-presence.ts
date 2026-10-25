import { existsSync } from 'node:fs';
import { DEFAULT_CLI_PATH, DEFAULT_ENGINE_DIR } from './subprocess-report-reader';

/**
 * The imported reader engine and its Python sidecar are optional: the public repository does not carry them. Switching the pipeline on
 * without them must stop the start with a message that says what is missing, not fail later on the first read with a spawn error.
 */
export function missingReaderEngineFiles(paths: { engineDir: string; cliPath: string } = { engineDir: DEFAULT_ENGINE_DIR, cliPath: DEFAULT_CLI_PATH }): string[] {
  return [paths.engineDir, paths.cliPath].filter((path) => !existsSync(path));
}

export function assertReaderEnginePresent(paths?: { engineDir: string; cliPath: string }): void {
  const missing = missingReaderEngineFiles(paths);
  if (missing.length > 0) {
    throw new Error(
      `LAB_REPORT_PIPELINE is enabled but the report-reader engine is not in this checkout (missing: ${missing.join(', ')}). ` +
        'The engine is not part of the public repository; leave the pipeline disabled, or add the engine files to run it.',
    );
  }
}
