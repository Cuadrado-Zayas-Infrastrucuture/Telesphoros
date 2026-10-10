import { ListObjectsV2Command, S3Client, type ListObjectsV2CommandOutput } from '@aws-sdk/client-s3';
import { mkdtempSync, unlinkSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyFile } from '../src/db/backup-crypto';
import * as cleanup from '../src/db/cleanup';
import { IncompleteBackupListingError, latestComplete, listBackups, type ReadTarget } from '../src/db/offsite';
import { runBackupCheck } from '../src/db/offsite-check';
import * as restore from '../src/db/restore';
import { restoreFromRemote } from '../src/db/restore-remote';

jest.mock('../src/db/cleanup', () => {
  const actual = jest.requireActual('../src/db/cleanup');
  return { ...actual, makeTempDir: jest.fn(actual.makeTempDir) };
});
jest.mock('../src/db/restore', () => ({ ...jest.requireActual('../src/db/restore'), restoreAndVerify: jest.fn() }));

const older = 'backup-2026-10-01T03-00-00-000Z';
const newer = 'backup-2026-10-02T03-00-00-000Z';
const prefixes = (names: string[]) => names.map((name) => ({ Prefix: `nightly/${name}/` }));
const page = (values: Partial<ListObjectsV2CommandOutput>): ListObjectsV2CommandOutput => ({ $metadata: {}, ...values });
const scratch = mkdtempSync(join(tmpdir(), 'discovery-test-'));
const keyFile = join(scratch, 'backup.key');
beforeAll(() => generateKeyFile(keyFile));
afterAll(() => { unlinkSync(keyFile); rmdirSync(scratch); });

function target(send: jest.Mock): ReadTarget {
  const client = new S3Client({ region: 'us-east-1', credentials: { accessKeyId: 'fixture', secretAccessKey: 'fixture' } });
  jest.spyOn(client, 'send').mockImplementation(send);
  return { client, bucket: 'synthetic-backups', prefix: 'nightly' };
}

afterEach(() => { jest.restoreAllMocks(); jest.clearAllMocks(); });

describe('complete backup discovery', () => {
  it('follows opaque continuation tokens, including an empty truncated page, and sorts all backup names', async () => {
    const send = jest.fn()
      .mockResolvedValueOnce(page({ IsTruncated: true, NextContinuationToken: 'opaque+/=', CommonPrefixes: prefixes([newer, 'readme']) }))
      .mockResolvedValueOnce(page({ IsTruncated: true, NextContinuationToken: 'next', CommonPrefixes: [] }))
      .mockResolvedValueOnce(page({ IsTruncated: false, CommonPrefixes: prefixes([older]) }));
    expect(await listBackups(target(send))).toEqual([older, newer]);
    expect(send.mock.calls.map(([command]: [ListObjectsV2Command]) => command.input)).toEqual([
      { Bucket: 'synthetic-backups', Prefix: 'nightly/', Delimiter: '/', ContinuationToken: undefined },
      { Bucket: 'synthetic-backups', Prefix: 'nightly/', Delimiter: '/', ContinuationToken: 'opaque+/=' },
      { Bucket: 'synthetic-backups', Prefix: 'nightly/', Delimiter: '/', ContinuationToken: 'next' },
    ]);
  });

  it('accepts an empty complete listing', async () => {
    expect(await latestComplete(target(jest.fn().mockResolvedValue(page({ IsTruncated: false }))))).toBeUndefined();
  });

  it('accepts a terminal page at the 1,000-page boundary', async () => {
    const send = jest.fn().mockImplementation(async () => page({
      IsTruncated: send.mock.calls.length < 1000,
      NextContinuationToken: `page-${send.mock.calls.length}`,
      CommonPrefixes: send.mock.calls.length === 1000 ? prefixes([newer]) : [],
    }));
    expect(await listBackups(target(send))).toEqual([newer]);
    expect(send).toHaveBeenCalledTimes(1000);
  });

  describe.each([
    ['missing token', () => page({ IsTruncated: true, CommonPrefixes: prefixes([older]) }), 1],
    ['null token', () => page({ IsTruncated: true, NextContinuationToken: null as unknown as string, CommonPrefixes: prefixes([older]) }), 1],
    ['empty token', () => page({ IsTruncated: true, NextContinuationToken: '', CommonPrefixes: prefixes([older]) }), 1],
    ['page limit', (n: number) => page({ IsTruncated: true, NextContinuationToken: `page-${n}`, CommonPrefixes: n === 1 ? prefixes([older]) : [] }), 1000],
  ] as const)('%s', (_name, response, expectedPages) => {
    it('throws a typed error rather than returning the partial backup window', async () => {
      const send = jest.fn().mockImplementation(async () => response(send.mock.calls.length));
      await expect(listBackups(target(send))).rejects.toBeInstanceOf(IncompleteBackupListingError);
      expect(send).toHaveBeenCalledTimes(expectedPages);
    });

    it('never fetches a manifest from a partial window when selecting latest', async () => {
      const send = jest.fn().mockImplementation(async (command) => {
        if (!(command instanceof ListObjectsV2Command)) throw new Error('Unexpected object download');
        return response(send.mock.calls.length);
      });
      await expect(latestComplete(target(send))).rejects.toMatchObject({ name: 'IncompleteBackupListingError' });
      expect(send).toHaveBeenCalledTimes(expectedPages);
      expect(send.mock.calls.every(([command]) => command instanceof ListObjectsV2Command)).toBe(true);
    });

    it('aborts remote recovery before temp files, object reads, or the restore engine', async () => {
      const send = jest.fn().mockImplementation(async () => response(send.mock.calls.length));
      const temp = jest.mocked(cleanup.makeTempDir);
      const engine = jest.mocked(restore.restoreAndVerify);
      const t = target(send);
      await expect(restoreFromRemote({
        adminUrl: 'postgresql://fixture:fixture@127.0.0.1:1/postgres',
        client: t.client, location: { bucket: t.bucket, prefix: t.prefix }, latest: true, keep: true,
      })).rejects.toMatchObject({ name: 'IncompleteBackupListingError' });
      expect(send).toHaveBeenCalledTimes(expectedPages);
      expect(send.mock.calls.every(([command]) => command instanceof ListObjectsV2Command)).toBe(true);
      expect(temp).not.toHaveBeenCalled();
      expect(engine).not.toHaveBeenCalled();
    });

    it('makes the freshness monitor fail without authentic/recent backup claims', async () => {
      const send = jest.fn().mockImplementation(async () => response(send.mock.calls.length));
      const t = target(send);
      const findings = await runBackupCheck({
        keyFile, bucket: t.bucket, prefix: t.prefix, clients: { read: t.client, upload: t.client }, skipCanary: true,
        settings: { region: 'us-east-1', forcePathStyle: true, lockMode: 'GOVERNANCE', retainDays: 30 },
      });
      expect(findings).toContainEqual({ name: 'newest backup', status: 'FAIL', detail: expect.stringContaining('IncompleteBackupListingError') });
      expect(findings.some((f) => f.name === 'newest backup is authentic' || f.name === 'newest backup is recent')).toBe(false);
      expect(send).toHaveBeenCalledTimes(expectedPages);
      expect(send.mock.calls.every(([command]) => command instanceof ListObjectsV2Command)).toBe(true);
    });
  });

  it('retains the existing failed report for an ordinary listing refusal', async () => {
    const t = target(jest.fn().mockRejectedValue(Object.assign(new Error('synthetic refusal'), { name: 'AccessDenied' })));
    expect(await restoreFromRemote({
      adminUrl: 'postgresql://fixture:fixture@127.0.0.1:1/postgres',
      client: t.client, location: { bucket: t.bucket, prefix: t.prefix }, latest: true,
    })).toMatchObject({ ok: false, checks: [{ name: 'download', ok: false }] });
  });
});
