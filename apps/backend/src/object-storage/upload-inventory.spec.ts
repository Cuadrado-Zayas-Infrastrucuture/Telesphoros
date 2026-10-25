import type { S3Client } from '@aws-sdk/client-s3';
import { uploadVersions, uploadMultipart, IncompleteUploadInventoryError } from './upload-inventory';
const client = (send: jest.Mock) => ({ send }) as unknown as S3Client;
it('does not return a partial inventory when continuation is missing or repeated', async () => {
  for (const send of [
    jest.fn().mockResolvedValue({ IsTruncated: true, Versions: [{ Key: 'k/1', VersionId: 'v' }] }),
    jest.fn().mockResolvedValue({ IsTruncated: true, NextKeyMarker: 'k/1', NextVersionIdMarker: 'v' }),
  ])
    await expect(uploadVersions(client(send), 'synthetic', 'k/', new AbortController().signal)).rejects.toBeInstanceOf(IncompleteUploadInventoryError);
});
it('refuses the 1000-page hard boundary without falling back to observed entries', async () => {
  let page = 0;
  const send = jest.fn(async () => ({ IsTruncated: true, NextKeyMarker: `k/${++page}`, NextVersionIdMarker: `v${page}` }));
  await expect(uploadVersions(client(send), 'synthetic', 'k/', new AbortController().signal)).rejects.toBeInstanceOf(IncompleteUploadInventoryError);
  expect(send).toHaveBeenCalledTimes(1000);
});
it('collects versions and delete markers only after a complete listing', async () => {
  const send = jest
    .fn()
    .mockResolvedValueOnce({ IsTruncated: true, Versions: [{ Key: 'k/1', VersionId: 'old' }], NextKeyMarker: 'k/1', NextVersionIdMarker: 'old' })
    .mockResolvedValueOnce({ IsTruncated: false, DeleteMarkers: [{ Key: 'k/1', VersionId: 'deleted' }] });
  expect(await uploadVersions(client(send), 'synthetic', 'k/', new AbortController().signal)).toEqual([
    { key: 'k/1', version: 'old', deleted: false },
    { key: 'k/1', version: 'deleted', deleted: true },
  ]);
});
it('multipart discovery refuses missing/repeated cursors and the hard cap', async () => {
  for (const send of [jest.fn().mockResolvedValue({ IsTruncated: true }), jest.fn().mockResolvedValue({ IsTruncated: true, NextKeyMarker: 'k/1', NextUploadIdMarker: 'u' })])
    await expect(uploadMultipart(client(send), 'synthetic', 'k/', new AbortController().signal)).rejects.toBeInstanceOf(IncompleteUploadInventoryError);
  let page = 0;
  const send = jest.fn(async () => ({ IsTruncated: true, NextKeyMarker: `k/${++page}`, NextUploadIdMarker: `u${page}` }));
  await expect(uploadMultipart(client(send), 'synthetic', 'k/', new AbortController().signal)).rejects.toBeInstanceOf(IncompleteUploadInventoryError);
  expect(send).toHaveBeenCalledTimes(1000);
});
it('multipart inventory completes all pages before returning exact IDs', async () => {
  const send = jest
    .fn()
    .mockResolvedValueOnce({ IsTruncated: true, Uploads: [{ Key: 'k/1', UploadId: 'u1' }], NextKeyMarker: 'k/1', NextUploadIdMarker: 'u1' })
    .mockResolvedValueOnce({ IsTruncated: false, Uploads: [{ Key: 'k/2', UploadId: 'u2' }] });
  expect(await uploadMultipart(client(send), 'synthetic', 'k/', new AbortController().signal)).toEqual([
    { key: 'k/1', uploadId: 'u1' },
    { key: 'k/2', uploadId: 'u2' },
  ]);
});
