import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { type ReaderBindings, readerBindingsSchema, type ReaderResult, readerResultSchema, failureResult, type ProcessingFailureReason } from './reader-result';
import { bindingMismatches } from './pinned-reader';
import { type ReadOptions, ReaderNotApprovedError, type ReaderLogger, type ReportReader } from './report-reader';

const REPO_ROOT = resolve(__dirname, '../../../../..');
export const DEFAULT_ENGINE_DIR = resolve(REPO_ROOT, 'knowledge/lab-report-reader/v2-handoff/engine');
export const DEFAULT_CLI_PATH = resolve(REPO_ROOT, 'sidecars/report-reader/reader_cli.py');

/** The engine refuses sources over 100 000 Unicode scalars. A string over twice that cannot be within it, so it is never sent. */
const MAX_TEXT_UTF16_UNITS = 200_000;
const MAX_STDERR_BYTES = 64 * 1024;

export interface SubprocessReportReaderOptions {
  /**
   * Required, with no default, so nobody gets the relaxed behaviour by forgetting to say.
   * The reader is NOT approved for production (the imported engine is authorized for offline construction only):
   * "production" is refused until a reviewed change lifts that.
   */
  mode: 'production' | 'non-production';
  engineDir?: string;
  /** Replaces the whole command (tests only): it receives the request on stdin and must print the JSON the CLI would. */
  command?: readonly string[];
  /** Overall deadline for one read, from spawn to exit. The engine has its own 2 s parse deadline inside this. */
  deadlineMs?: number;
  /** After the deadline: SIGTERM to the process group, then SIGKILL this much later. */
  killGraceMs?: number;
  maxOutputBytes?: number;
  logger?: ReaderLogger;
}

type RunOutcome =
  { ok: true; stdout: Buffer } | { ok: false; reason: ProcessingFailureReason; cause: string; fields: Record<string, unknown> } | { ok: false; cancelled: true; reason: unknown };

/** Runs the sidecar as a child process: no shell, a minimal environment, bounded input, output and time. */
export class SubprocessReportReader implements ReportReader {
  private readonly engineDir: string;
  private readonly deadlineMs: number;
  private readonly killGraceMs: number;
  private readonly maxOutputBytes: number;
  private readonly logger?: ReaderLogger;
  private readonly commandOverride?: readonly string[];

  constructor(options: SubprocessReportReaderOptions) {
    if (options.mode === 'production') throw new ReaderNotApprovedError('The report reader is not approved for production use.');
    this.engineDir = options.engineDir ?? DEFAULT_ENGINE_DIR;
    this.deadlineMs = options.deadlineMs ?? 8_000;
    this.killGraceMs = options.killGraceMs ?? 1_000;
    this.maxOutputBytes = options.maxOutputBytes ?? 6_000_000;
    this.logger = options.logger;
    this.commandOverride = options.command;
  }

  async read(text: string, options: ReadOptions = {}): Promise<ReaderResult> {
    if (typeof text !== 'string') throw new TypeError('text must be a string');
    // A read cancelled before it starts never spawns.
    options.signal?.throwIfAborted();
    // Bounded before anything is allocated or spawned. The engine applies the exact limit in Unicode scalars.
    if (text.length > MAX_TEXT_UTF16_UNITS) return failureResult('source-limit');

    // JSON.stringify escapes lone surrogates, so invalid text reaches the engine intact and is refused there.
    const outcome = await this.run('process', JSON.stringify({ text }), text.length, options.signal);
    if (!outcome.ok && 'cancelled' in outcome) throw outcome.reason;
    if (!outcome.ok) return this.failed(outcome, text.length);

    let parsed: unknown;
    try {
      parsed = JSON.parse(outcome.stdout.toString('utf8'));
    } catch {
      return this.failed({ ok: false, reason: 'worker-error', cause: 'output-not-json', fields: {} }, text.length);
    }
    const result = readerResultSchema.safeParse(parsed);
    if (!result.success) {
      // Paths only: a validation message could echo a value from the report.
      const fields = { invalidAt: result.error.issues.slice(0, 5).map((issue) => issue.path.join('.')) };
      return this.failed({ ok: false, reason: 'worker-error', cause: 'output-shape', fields }, text.length);
    }
    return result.data;
  }

  /** The build bindings of the engine this reader runs, for comparison with PINNED_READER at startup. */
  async bindings(): Promise<ReaderBindings> {
    const outcome = await this.run('bindings', '', 0);
    if (!outcome.ok) throw new Error(`The reader could not report its bindings (${'cause' in outcome ? outcome.cause : 'cancelled'}).`);
    return readerBindingsSchema.parse(JSON.parse(outcome.stdout.toString('utf8')));
  }

  /** Fails closed if the engine on disk is not the pinned one. Returns the names of the bindings that differ (never values). */
  async verifyPinned(): Promise<Array<keyof ReaderBindings>> {
    return bindingMismatches(await this.bindings());
  }

  private failed(outcome: Extract<RunOutcome, { cause: string }>, textChars: number): ReaderResult {
    this.logger?.warn({ event: 'report-reader-failure', reason: outcome.reason, cause: outcome.cause, textChars, ...outcome.fields }, 'Report reader did not return a result');
    return failureResult(outcome.reason);
  }

  private run(command: 'process' | 'bindings', input: string, textChars: number, signal?: AbortSignal): Promise<RunOutcome> {
    const [file, ...args] = this.commandOverride ?? ['python3', '-I', '-B', DEFAULT_CLI_PATH, this.engineDir, command];
    const started = Date.now();
    return new Promise((resolveOutcome) => {
      const child = spawn(file!, args, {
        shell: false,
        // Its own process group, so one signal reaches the engine's worker too.
        detached: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        // Nothing inherited but PATH. No PYTHONPATH, no credentials. No bytecode written into the imported engine directory.
        env: { PATH: process.env.PATH ?? '/usr/bin:/bin', PYTHONDONTWRITEBYTECODE: '1' },
      });

      const out: Buffer[] = [];
      let outBytes = 0;
      let errBuffer = Buffer.alloc(0);
      let stderrBytes = 0;
      let settled = false;
      let killReason: { reason: ProcessingFailureReason; cause: string } | null = null;
      let killTimer: NodeJS.Timeout | undefined;
      let exitTimer: NodeJS.Timeout | undefined;
      let heldOpen: (() => void) | undefined;
      // After the exit, every chunk still draining from the pipes restarts the wait: only a pipe that is open AND idle counts as held.
      const rearmHeldOpen = () => {
        if (!heldOpen) return;
        if (exitTimer) clearTimeout(exitTimer);
        exitTimer = setTimeout(heldOpen, this.killGraceMs);
      };

      const killGroup = (signal: NodeJS.Signals) => {
        try {
          if (child.pid !== undefined) process.kill(-child.pid, signal);
        } catch {
          // intentional: the group is already gone (ESRCH), which is exactly what we want
        }
      };
      const terminate = (reason: ProcessingFailureReason, cause: string) => {
        if (killReason) return;
        killReason = { reason, cause };
        killGroup('SIGTERM');
        killTimer = setTimeout(() => killGroup('SIGKILL'), this.killGraceMs);
      };

      const deadline = setTimeout(() => terminate('source-time-budget', 'deadline'), this.deadlineMs);
      // Cancelling stops the group the same way as the deadline; the read settles on 'close', so never before the process has exited.
      let cancelled = false;
      const onAbort = () => {
        cancelled = true;
        terminate('worker-error', 'cancelled');
      };
      signal?.addEventListener('abort', onAbort, { once: true });

      const finish = (outcome: RunOutcome) => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        if (killTimer) clearTimeout(killTimer);
        if (exitTimer) clearTimeout(exitTimer);
        signal?.removeEventListener('abort', onAbort);
        resolveOutcome(cancelled ? { ok: false, cancelled: true, reason: signal!.reason } : outcome);
      };

      child.stdout.on('data', (chunk: Buffer) => {
        rearmHeldOpen();
        outBytes += chunk.length;
        if (outBytes > this.maxOutputBytes) return terminate('worker-error', 'output-limit');
        out.push(chunk);
      });
      child.stderr.on('data', (chunk: Buffer) => {
        rearmHeldOpen();
        stderrBytes += chunk.length;
        if (errBuffer.length < MAX_STDERR_BYTES) errBuffer = Buffer.concat([errBuffer, chunk]).subarray(0, MAX_STDERR_BYTES);
      });
      child.stdin.on('error', () => undefined); // intentional: the child may exit before reading; its exit code tells the story
      child.on('error', () => finish({ ok: false, reason: 'worker-error', cause: 'spawn-failed', fields: {} }));
      // 'close' waits for the pipes as well as the exit. A descendant that left the process group (out of the group kill's reach) can hold
      // them open forever, and the read would never free its limiter slot (audit O2). Once the process has exited and the pipes have been silent for
      // one kill grace without 'close', stop reading and fail: output from a reader that left a process behind is not trusted, even after a
      // clean exit.
      child.on('exit', (code, signal) => {
        heldOpen = () => {
          child.stdout.destroy();
          child.stderr.destroy();
          killGroup('SIGKILL');
          finish({ ok: false, reason: 'worker-error', cause: 'output-held-open', fields: { exitCode: code, signal, durationMs: Date.now() - started, textChars } });
        };
        rearmHeldOpen();
      });
      child.on('close', (code, signal) => {
        // Whatever happened, nothing the child started may outlive it.
        if (killReason) killGroup('SIGKILL');
        if (killReason) return finish({ ok: false, ...killReason, fields: { signal, durationMs: Date.now() - started } });
        if (code !== 0) {
          const safe = safeReaderError(errBuffer.toString('utf8'));
          return finish({
            ok: false,
            reason: 'worker-error',
            cause: 'exit',
            fields: { exitCode: code, signal, stderrBytes, durationMs: Date.now() - started, textChars, ...safe },
          });
        }
        finish({ ok: true, stdout: Buffer.concat(out) });
      });

      child.stdin.end(input);
    });
  }
}

/**
 * The wrapper prints one structured line on failure: an exception class name and `name:line` frames, never a message.
 * Only a line of exactly that shape is passed on, and only after each part is checked against a strict pattern, so
 * nothing else the process wrote to stderr (which could contain report text) can reach a log.
 */
function safeReaderError(stderr: string): { readerError?: string; frames?: string[] } {
  const last = stderr.trim().split('\n').pop() ?? '';
  try {
    const value: unknown = JSON.parse(last);
    if (typeof value !== 'object' || value === null) return {};
    const { readerError, frames } = value as { readerError?: unknown; frames?: unknown };
    if (typeof readerError !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(readerError)) return {};
    if (!Array.isArray(frames) || frames.length > 16 || !frames.every((f) => typeof f === 'string' && /^[A-Za-z_<][A-Za-z0-9_<>]{0,63}:\d{1,6}$/.test(f))) return { readerError };
    return { readerError, frames: frames as string[] };
  } catch {
    return {};
  }
}
