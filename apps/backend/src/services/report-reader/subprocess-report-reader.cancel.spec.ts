import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SubprocessReportReader } from './subprocess-report-reader';

// Cancellation with stand-in commands only: nothing here needs the report-reader engine, so it runs in the public checkout too.
const reader = (extra: Partial<ConstructorParameters<typeof SubprocessReportReader>[0]> = {}) => new SubprocessReportReader({ mode: 'non-production', ...extra });
const sh = (script: string) => ['sh', '-c', script];

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const waitFor = async (check: () => boolean, ms = 3_000) => {
  for (const until = Date.now() + ms; !check() && Date.now() < until;) await new Promise((r) => setTimeout(r, 20));
  return check();
};

describe('cancelling a read', () => {
  it('never spawns when the signal is already aborted, and rejects with its reason', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'reader-cancel-'));
    const marker = join(dir, 'spawned');
    const controller = new AbortController();
    const reason = new Error('cancelled before start');
    controller.abort(reason);
    await expect(reader({ command: sh(`touch ${marker}`) }).read('x', { signal: controller.signal })).rejects.toBe(reason);
    await new Promise((r) => setTimeout(r, 200));
    expect(existsSync(marker)).toBe(false);
  });

  it('kills the whole process tree during a read, and settles only after the child has exited', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'reader-cancel-'));
    const [shellPid, grandchildPid] = [join(dir, 'shell.pid'), join(dir, 'grandchild.pid')];
    // The shell ignores SIGTERM and starts a grandchild: only the group SIGKILL after the grace period ends both.
    const r = reader({
      command: sh(`trap '' TERM; echo $$ > ${shellPid}; sleep 60 & echo $! > ${grandchildPid}; while :; do sleep 1; done`),
      deadlineMs: 30_000,
      killGraceMs: 200,
    });
    const controller = new AbortController();
    const read = r.read('x', { signal: controller.signal });
    expect(await waitFor(() => existsSync(grandchildPid) && readFileSync(grandchildPid, 'utf8').trim() !== '')).toBe(true);
    const shell = Number(readFileSync(shellPid, 'utf8').trim());
    const grandchild = Number(readFileSync(grandchildPid, 'utf8').trim());
    expect(alive(shell)).toBe(true); // control: the process was really running when we cancelled

    const started = Date.now();
    controller.abort();
    await expect(read).rejects.toMatchObject({ name: 'AbortError' });
    expect(Date.now() - started).toBeLessThan(5_000); // the deadline (30 s) did not end it; the cancellation did
    expect(alive(shell)).toBe(false);
    expect(await waitFor(() => !alive(grandchild))).toBe(true);
  }, 15_000);

  it('answers as before when the signal is never aborted (a failing command is still a hold, not a rejection)', async () => {
    const controller = new AbortController();
    const result = await reader({ command: sh('exit 3') }).read('x', { signal: controller.signal });
    expect(result.projection).toMatchObject({ status: 'held', reason: 'worker-error' });
  });

  it('ignores an abort that comes after the read has finished', async () => {
    const controller = new AbortController();
    const result = await reader({ command: sh('exit 3') }).read('x', { signal: controller.signal });
    controller.abort();
    expect(result.projection.reason).toBe('worker-error');
  });
});
