import { createHash } from 'node:crypto';
import { mkdtemp, open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import type { Readable } from 'node:stream';
import { MAX_REPORT_BYTES, type ReportType } from '@telesphoros/shared-types';
import { removeStaging, writeStagingReceipt, type StagingReceipt } from './staging-receipt';
import { StructuralValidator } from './structural-validator';
export class StagingDisposalError extends Error {
    constructor() { super('Owned staging cleanup incomplete.'); this.name = 'StagingDisposalError'; }
}
export class IntakeRejectedError extends Error {
    constructor(readonly reason: 'timeout' | 'slow' | 'size' | 'checksum' | 'cancelled') { super('File intake refused.'); this.name = 'IntakeRejectedError'; }
}
export class IntakeProgress {
    private readonly start: number;
    private last: number;
    private window: number;
    private windowBytes = 0;
    private pausedAt: number | undefined;
    constructor(private readonly now = () => performance.now()) { this.start = this.last = this.window = now(); }
    add(bytes: number) { this.last = this.now(); this.windowBytes += bytes; }
    pause() { this.pausedAt = this.now(); }
    resume() { if (this.pausedAt !== undefined) {
        const elapsed = this.now() - this.pausedAt;
        this.last += elapsed;
        this.window += elapsed;
        this.pausedAt = undefined;
    } }
    check(complete = false) {
        const now = this.now();
        if (this.pausedAt !== undefined) {
            if (now - this.pausedAt >= 5000 || now - this.start >= 60000)
                throw new IntakeRejectedError('timeout');
            return;
        }
        if (now - this.start >= 60000 || now - this.last >= 10000)
            throw new IntakeRejectedError('timeout');
        if (!complete && now - this.window >= 5000) {
            if (this.window - this.start >= 5000 && this.windowBytes / ((now - this.window) / 1000) < 262144)
                throw new IntakeRejectedError('slow');
            this.window = now;
            this.windowBytes = 0;
        }
    }
}
export interface StagedFile {
    path: string;
    bytes: number;
    sha256: string;
    receipt: StagingReceipt;
    dispose(): Promise<void>;
}
/** An owned 0700 directory + exclusive 0600 file. Validation completes before this file can be sent to storage. */
export async function stage(source: Readable, type: ReportType, expectedBytes: number, expectedHash: string, signal: AbortSignal, runId: string): Promise<StagedFile> {
    const root = await mkdtemp(join(tmpdir(), 'telesphoros-intake-'));
    const path = join(root, 'payload');
    let receipt: StagingReceipt;
    let file: Awaited<ReturnType<typeof open>>;
    try {
        receipt = await writeStagingReceipt(root, runId);
        file = await open(path, 'wx', 0o600);
    }
    catch (error) {
        try {
            await removeStaging(root);
        }
        catch {
            throw new StagingDisposalError();
        }
        throw error;
    }
    let closed = false;
    const dispose = async () => {
        if (!closed) {
            await file.close();
            closed = true;
        }
        await removeStaging(root); // Exact resources created above, never a recursive/path-derived deletion.
    };
    const progress = new IntakeProgress();
    const hash = createHash('sha256');
    const syntax = new StructuralValidator(type);
    let bytes = 0;
    const abort = () => source.destroy(new IntakeRejectedError('cancelled'));
    signal.addEventListener('abort', abort, { once: true });
    const timer = setInterval(() => { try {
        progress.check();
    }
    catch (error) {
        source.destroy(error as Error);
    } }, 250);
    try {
        if (signal.aborted) {
            source.destroy();
            throw new IntakeRejectedError('cancelled');
        }
        for await (const raw of source) {
            const chunk = raw as Buffer;
            bytes += chunk.length;
            if (bytes > MAX_REPORT_BYTES || bytes > expectedBytes)
                throw new IntakeRejectedError('size');
            progress.add(chunk.length);
            progress.check();
            hash.update(chunk);
            // Bound parser state and write buffers even if a custom transport yields a large chunk.
            for (let offset = 0; offset < chunk.length; offset += 65536) {
                const part = chunk.subarray(offset, offset + 65536);
                syntax.feed(part);
                let written = 0;
                progress.pause();
                try {
                    while (written < part.length) {
                        const out = await file.write(part.subarray(written));
                        if (!out.bytesWritten)
                            throw new IntakeRejectedError('size');
                        written += out.bytesWritten;
                    }
                }
                finally {
                    progress.check();
                    progress.resume();
                }
                // Backpressure: never queue an entire upload in RAM.
            }
        }
        progress.check(true);
        if (bytes !== expectedBytes || !bytes)
            throw new IntakeRejectedError('size');
        syntax.finish();
        const sha256 = hash.digest('hex');
        if (sha256 !== expectedHash)
            throw new IntakeRejectedError('checksum');
        await file.close();
        closed = true;
        return { path, bytes, sha256, receipt, dispose };
    }
    catch (error) {
        try {
            await dispose();
        }
        catch {
            throw new StagingDisposalError();
        }
        throw error;
    }
    finally {
        clearInterval(timer);
        signal.removeEventListener('abort', abort);
    }
}
