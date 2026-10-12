import { ListObjectVersionsCommand, ListMultipartUploadsCommand, type S3Client } from '@aws-sdk/client-s3';
export class IncompleteUploadInventoryError extends Error {
    constructor() { super('Upload inventory incomplete; no cleanup permitted.'); this.name = 'IncompleteUploadInventoryError'; }
}
export interface UploadVersion {
    key: string;
    version: string;
    deleted: boolean;
}
/** Finish ALL pages before returning any candidates; cursors and the hard cap are fail closed. */
export async function uploadVersions(client: S3Client, bucket: string, prefix: string, signal: AbortSignal): Promise<UploadVersion[]> {
    const versions: UploadVersion[] = [];
    const seen = new Set<string>();
    let keyMarker: string | undefined;
    let versionMarker: string | undefined;
    for (let page = 0; page < 1000; page++) {
        let out;
        try {
            out = await client.send(new ListObjectVersionsCommand({ Bucket: bucket, Prefix: prefix, KeyMarker: keyMarker, VersionIdMarker: versionMarker }), { abortSignal: signal });
        }
        catch {
            throw new IncompleteUploadInventoryError();
        }
        if (typeof out.IsTruncated !== 'boolean')
            throw new IncompleteUploadInventoryError();
        for (const [items, deleted] of [[out.Versions ?? [], false], [out.DeleteMarkers ?? [], true]] as const)
            for (const v of items) {
                if (!v.Key || !v.VersionId || v.VersionId === 'null' || !v.Key.startsWith(prefix) || versions.length >= 10000)
                    throw new IncompleteUploadInventoryError();
                versions.push({ key: v.Key, version: v.VersionId, deleted });
            }
        if (!out.IsTruncated)
            return versions;
        if (!out.NextKeyMarker || !out.NextVersionIdMarker)
            throw new IncompleteUploadInventoryError();
        const cursor = JSON.stringify([out.NextKeyMarker, out.NextVersionIdMarker]);
        if (seen.has(cursor))
            throw new IncompleteUploadInventoryError();
        seen.add(cursor);
        keyMarker = out.NextKeyMarker;
        versionMarker = out.NextVersionIdMarker;
    }
    throw new IncompleteUploadInventoryError();
}
export interface UploadMultipart {
    key: string;
    uploadId: string;
}
/** Complete multipart inventory before either releasing quota or compensating bytes. */
export async function uploadMultipart(client: S3Client, bucket: string, prefix: string, signal: AbortSignal): Promise<UploadMultipart[]> {
    const uploads: UploadMultipart[] = [];
    const cursors = new Set<string>();
    let key: string | undefined;
    let upload: string | undefined;
    for (let page = 0; page < 1000; page++) {
        let out;
        try {
            out = await client.send(new ListMultipartUploadsCommand({ Bucket: bucket, Prefix: prefix, KeyMarker: key, UploadIdMarker: upload }), { abortSignal: signal });
        }
        catch {
            throw new IncompleteUploadInventoryError();
        }
        if (typeof out.IsTruncated !== 'boolean')
            throw new IncompleteUploadInventoryError();
        for (const u of out.Uploads ?? []) {
            if (!u.Key || !u.UploadId || !u.Key.startsWith(prefix) || uploads.length >= 10000)
                throw new IncompleteUploadInventoryError();
            uploads.push({ key: u.Key, uploadId: u.UploadId });
        }
        if (!out.IsTruncated)
            return uploads;
        if (!out.NextKeyMarker || !out.NextUploadIdMarker)
            throw new IncompleteUploadInventoryError();
        const cursor = JSON.stringify([out.NextKeyMarker, out.NextUploadIdMarker]);
        if (cursors.has(cursor))
            throw new IncompleteUploadInventoryError();
        cursors.add(cursor);
        key = out.NextKeyMarker;
        upload = out.NextUploadIdMarker;
    }
    throw new IncompleteUploadInventoryError();
}
