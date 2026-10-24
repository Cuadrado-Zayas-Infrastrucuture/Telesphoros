import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { transformFileSync } from '@swc/core';
import { makeTempDir, sweepStaleTempDirs } from '../src/db/cleanup';

// Two things here must not touch the temp dir other processes use: the folders this file plants and sweeps in-process, and the ones the
// child processes make. A neighbour's `restore-*` count (offsite-restore and backup-restore specs) would change, or a stale-folder sweep
// there would delete them. The mock covers this process; the children get the same root through TMPDIR, which they read directly.
jest.mock('node:os', () => {
  const actual = jest.requireActual<typeof import('node:os')>('node:os');
  const { mkdtempSync } = jest.requireActual<typeof import('node:fs')>('node:fs');
  const { join } = jest.requireActual<typeof import('node:path')>('node:path');
  let root: string | undefined; // made on first use
  return { ...actual, tmpdir: () => (root ??= mkdtempSync(join(actual.tmpdir(), 'cleanup-spec-private-'))) };
});
const PRIVATE_TMP = 'cleanup-spec-private-';
const childEnv = () => ({ ...process.env, TMPDIR: tmpdir() });

const scratch = mkdtempSync(join(tmpdir(), 'cleanup-spec-'));
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
  if (basename(tmpdir()).startsWith(PRIVATE_TMP)) rmSync(tmpdir(), { recursive: true, force: true }); // never the shared one
});

it('runs in its own temp root, not the one shared with other processes', () => {
  expect(basename(tmpdir())).toMatch(/^cleanup-spec-private-/);
  expect(childEnv().TMPDIR).toBe(tmpdir());
});

/** The module under test, compiled to plain CommonJS so a separate process can load it. */
const compiled = join(scratch, 'cleanup.cjs');
beforeAll(() => {
  const { code } = transformFileSync(join(__dirname, '..', 'src', 'db', 'cleanup.ts'), { jsc: { parser: { syntax: 'typescript' }, target: 'es2022' }, module: { type: 'commonjs' } });
  writeFileSync(compiled, code);
});

/**
 * Starts a process that makes a temp folder holding a "decrypted dump", prints its path, then does `ending`.
 * Resolves with the folder, its exit code and whether the folder still exists afterwards.
 */
function runChild(ending: string, signal?: NodeJS.Signals): Promise<{ dir: string; code: number | null; stillThere: boolean; signalled: NodeJS.Signals | null }> {
  const script = `
    const { makeTempDir } = require(${JSON.stringify(compiled)});
    const { writeFileSync } = require('node:fs');
    const t = makeTempDir('restore-');
    writeFileSync(t.path + '/db.dump', 'decrypted clinical data');
    process.stdout.write(t.path + '\\n');
    ${ending}
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'ignore'], env: childEnv() });
    let dir = '';
    child.stdout.on('data', (chunk: Buffer) => {
      dir += chunk.toString();
      if (signal && dir.includes('\n')) child.kill(signal);
    });
    child.on('error', reject);
    // 'close', not 'exit': 'exit' can fire before the child's output has been read (more often under load), which left `dir` empty.
    child.on('close', (code, signalled) => resolve({ dir: dir.trim(), code, signalled, stillThere: existsSync(dir.trim()) }));
  });
}

describe('temporary folders that hold decrypted data', () => {
  it('are removed when the process ends normally, with an error, or with an uncaught exception', async () => {
    for (const ending of ['process.exit(0)', 'process.exitCode = 3', 'throw new Error("boom")']) {
      const result = await runChild(ending);
      expect(result.dir).toMatch(/restore-[A-Za-z0-9]{6}$/);
      expect(dirname(result.dir)).toBe(tmpdir()); // made in the private root, not the shared one
      expect(result.stillThere).toBe(false);
    }
  });

  it.each([['SIGTERM', 143], ['SIGINT', 130], ['SIGHUP', 129]] as const)('are removed when the process receives %s, and it exits with the conventional code', async (signal, code) => {
    const result = await runChild('setInterval(() => {}, 1000)', signal);
    expect(result.dir).toMatch(/restore-/);
    expect(dirname(result.dir)).toBe(tmpdir());
    expect(result.signalled).toBeNull(); // it handled the signal itself rather than dying from it
    expect(result.code).toBe(code);
    expect(result.stillThere).toBe(false);
  });

  it('control: without the cleanup, a signalled process leaves the folder behind (so the tests above prove something)', async () => {
    const script = `const { mkdtempSync, writeFileSync } = require('node:fs'); const { tmpdir } = require('node:os'); const d = mkdtempSync(tmpdir() + '/restore-'); writeFileSync(d + '/db.dump', 'x'); process.stdout.write(d + '\\n'); setInterval(() => {}, 1000);`;
    const dir = await new Promise<string>((resolve) => {
      const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'ignore'], env: childEnv() });
      let out = '';
      child.stdout.on('data', (chunk: Buffer) => {
        out += chunk.toString();
        if (out.includes('\n')) child.kill('SIGTERM');
      });
      child.on('close', () => resolve(out.trim())); // 'close': after the output has been read, which 'exit' does not promise
    });
    expect(dirname(dir)).toBe(tmpdir());
    expect(existsSync(dir)).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it('dispose removes it now and can be called twice', () => {
    const t = makeTempDir('restore-');
    writeFileSync(join(t.path, 'x'), 'y');
    t.dispose();
    expect(existsSync(t.path)).toBe(false);
    expect(() => t.dispose()).not.toThrow();
  });

  it('are owner-only', () => {
    const t = makeTempDir('restore-');
    expect(statSync(t.path).mode & 0o077).toBe(0);
    t.dispose();
  });
});

describe('sweeping leftovers from a run that was killed outright (SIGKILL cannot be trapped)', () => {
  const old = (name: string, mode = 0o700) => {
    const path = join(tmpdir(), name);
    mkdirSync(path, { mode });
    chmodSync(path, mode);
    writeFileSync(join(path, 'db.dump'), 'leftover');
    const longAgo = new Date(Date.now() - 24 * 3600_000);
    utimesSync(path, longAgo, longAgo);
    return path;
  };

  it('removes our old folders, and only those', () => {
    const stale = old('restore-Ab12Cd');
    const staleDownload = old('restore-dl-Ef34Gh');
    const young = join(tmpdir(), 'restore-Young1');
    mkdirSync(young, { mode: 0o700 });
    const notOurs = old('restore-points-of-sale'); // does not match the pattern
    const shared = old('restore-Sh4red', 0o755); // not owner-only: never touch
    try {
      const removed = sweepStaleTempDirs();
      expect(removed).toBeGreaterThanOrEqual(2);
      expect(existsSync(stale)).toBe(false);
      expect(existsSync(staleDownload)).toBe(false);
      expect(existsSync(young)).toBe(true);
      expect(existsSync(notOurs)).toBe(true);
      expect(existsSync(shared)).toBe(true);
      expect(readdirSync(tmpdir()).includes('restore-Ab12Cd')).toBe(false);
    } finally {
      for (const p of [stale, staleDownload, young, notOurs, shared]) rmSync(p, { recursive: true, force: true });
    }
  });

  it('never removes a folder this process is still using', () => {
    const t = makeTempDir('restore-');
    const longAgo = new Date(Date.now() - 24 * 3600_000);
    utimesSync(t.path, longAgo, longAgo);
    sweepStaleTempDirs();
    expect(existsSync(t.path)).toBe(true);
    t.dispose();
  });
});
