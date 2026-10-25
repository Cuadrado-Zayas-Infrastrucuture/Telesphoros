import { randomUUID } from 'node:crypto';
import { lstat, open, readdir, readFile, rmdir, unlink } from 'node:fs/promises';
import { basename, join } from 'node:path';
export interface StagingReceipt {
  root: string;
  runId: string;
  nonce: string;
  pid: number;
  createdAt: string;
}
/** Save this receipt in the owned run manifest before a restart sweep. No inferred ownership from a directory prefix. */
export async function writeStagingReceipt(root: string, runId: string): Promise<StagingReceipt> {
  const receipt = { root, runId, nonce: randomUUID(), pid: process.pid, createdAt: new Date().toISOString() };
  const file = await open(join(root, 'receipt.json'), 'wx', 0o600);
  try {
    await file.writeFile(JSON.stringify(receipt));
    await file.sync();
  } finally {
    await file.close();
  }
  return receipt;
}
export async function removeStaging(root: string) {
  for (const name of ['payload', 'receipt.json']) {
    try {
      await unlink(join(root, name));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  await rmdir(root);
}
/** Explicit operations helper only; L3 owns scheduling and its durable manifest. Retain unexpected state or live writers. */
export async function reconcileStaging(receipt: StagingReceipt): Promise<void> {
  if (
    !/^telesphoros-intake-/.test(basename(receipt.root)) ||
    !/^[-0-9a-f]{36}$/.test(receipt.runId) ||
    !/^[-0-9a-f]{36}$/.test(receipt.nonce) ||
    !Number.isSafeInteger(receipt.pid) ||
    receipt.pid < 1
  )
    throw new Error('Staging ownership unavailable.');
  const dir = await lstat(receipt.root);
  if (!dir.isDirectory() || dir.isSymbolicLink() || dir.uid !== process.getuid?.() || (dir.mode & 0o777) !== 0o700) throw new Error('Staging ownership unavailable.');
  const names = await readdir(receipt.root);
  if (names.some((n) => !['payload', 'receipt.json'].includes(n)) || !names.includes('receipt.json')) throw new Error('Staging inventory incomplete.');
  for (const name of names) {
    const s = await lstat(join(receipt.root, name));
    if (!s.isFile() || s.isSymbolicLink() || s.uid !== dir.uid || (s.mode & 0o777) !== 0o600 || (name === 'receipt.json' && s.size > 1024))
      throw new Error('Staging ownership unavailable.');
  }
  const saved = JSON.parse(await readFile(join(receipt.root, 'receipt.json'), 'utf8')) as StagingReceipt;
  if (JSON.stringify(saved) !== JSON.stringify(receipt)) throw new Error('Staging receipt mismatch.');
  try {
    process.kill(receipt.pid, 0);
    throw new Error('Staging writer is live.');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
  await removeStaging(receipt.root);
}
