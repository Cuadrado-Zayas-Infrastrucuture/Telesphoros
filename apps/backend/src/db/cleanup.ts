import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Temporary folders that may hold a decrypted dump (restore) or a downloaded backup are removed on every way out we
 * can still run code on: normal return, a thrown error, an uncaught exception, and the signals SIGINT, SIGTERM and
 * SIGHUP (a terminal Ctrl-C, `kill`, a closed session). SIGKILL and a power cut cannot be trapped; for those,
 * `sweepStaleTempDirs` removes leftovers from earlier runs the next time a restore starts.
 */
const tracked = new Set<string>();
let installed = false;

function sweep() {
  for (const dir of tracked) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // intentional: best effort while the process is already leaving; the stale sweep will retry next time
    }
  }
  tracked.clear();
}

function install() {
  if (installed) return;
  installed = true;
  process.on('exit', sweep);
  const signals: [NodeJS.Signals, number][] = [
    ['SIGINT', 130],
    ['SIGTERM', 143],
    ['SIGHUP', 129],
  ];
  for (const [signal, code] of signals) {
    process.on(signal, () => {
      sweep();
      process.exit(code);
    });
  }
}

export interface TempDir {
  path: string;
  /** Removes it now. Safe to call twice. */
  dispose(): void;
}

/** A new owner-only folder under the OS temp dir that is removed however the process ends (see above). */
export function makeTempDir(prefix: string): TempDir {
  install();
  const path = mkdtempSync(join(tmpdir(), prefix));
  tracked.add(path);
  return {
    path,
    dispose() {
      tracked.delete(path);
      rmSync(path, { recursive: true, force: true });
    },
  };
}

const OURS = /^restore-(dl-)?[A-Za-z0-9]{6}$/;

/** Removes our own leftover folders older than `olderThanMs` (a run that was killed with SIGKILL). Returns how many. */
export function sweepStaleTempDirs(olderThanMs = 6 * 3600_000, now = Date.now()): number {
  let removed = 0;
  for (const name of readdirSync(tmpdir())) {
    if (!OURS.test(name)) continue;
    const path = join(tmpdir(), name);
    try {
      const stat = statSync(path);
      // Only folders we own and that are owner-only: never someone else's.
      if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) continue;
      if (now - stat.mtimeMs < olderThanMs || tracked.has(path)) continue;
      rmSync(path, { recursive: true, force: true });
      removed += 1;
    } catch {
      // intentional: it vanished or is not ours to touch; either way there is nothing to do
    }
  }
  return removed;
}
