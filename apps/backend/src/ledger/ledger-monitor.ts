import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { AppException } from '../common/app-exception';
import { LedgerStatus, type TailState, type VerifySource } from './ledger-status';
import type { VerifyOptions, VerifyResult } from './verifier';

export const LEDGER_VERIFIER = Symbol('LEDGER_VERIFIER');
export const LEDGER_WATCH_CONFIG = Symbol('LEDGER_WATCH_CONFIG');

/** What the monitor needs from a verifier (the real one is `LedgerVerifier`; unit tests pass a fake). */
export interface VerifierPort {
  tenants(): Promise<string[]>;
  verify(tenantId: string, options?: VerifyOptions): Promise<VerifyResult>;
  close(): Promise<void>;
}

export interface LedgerWatchConfig {
  /** Production refuses to start when the checks at start fail or do not finish in time; other environments warn and continue. */
  production: boolean;
  /** The checks at start may take this long IN TOTAL, across every tenant. */
  startupBudgetMs: number;
  /** Time between full walks. 0 turns the timer off. Each delay is jittered by up to 10% either way. */
  fullIntervalMs: number;
  /** Time one tenant's full walk may take in the background or on the timer. */
  fullBudgetMs: number;
  /** Time one check asked for over HTTP may take. */
  onDemandBudgetMs: number;
  /** A chain of at most this many events gets a FULL walk at start even when a checkpoint exists (a checkpoint is a shortcut, not a control). */
  fullWalkAtOrBelowEvents: number;
}

/** Measured in slice 5B-3.3c (docs/ops/ledger-watch.md): these are the defaults the environment settings are layered over. */
export const FULL_WALK_AT_OR_BELOW_EVENTS = 50_000;
export const FULL_BUDGET_MS = 15 * 60_000;
export const ON_DEMAND_BUDGET_MS = 30_000;

const BUSY = Symbol('busy');

/**
 * The ledger watch (specification 6.6 and 6.7). It owns the verifier connection and the in-process `LedgerStatus`:
 *
 *   1. At start, each tenant's chain is checked from its latest checkpoint within one total budget. Production refuses to start unless
 *      every tenant is `ok`; other environments log and carry on.
 *   2. Right after start, and then on a timer, every tenant's whole chain is walked and a checkpoint is recorded on success.
 *   3. A `failed` walk, from any of these or from the admin endpoint, LATCHES the instance: readiness fails and no record is written until
 *      the process is restarted after an investigation. Reads continue.
 *
 * Only one verification runs at a time in this process. What is logged and returned names kinds of failure and sequence numbers, never a
 * value from a record.
 */
@Injectable()
export class LedgerMonitor implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger('LedgerWatch');
  private readonly abort = new AbortController();
  private running: Promise<unknown> | null = null;
  private pass: Promise<void> | null = null;
  private passInProgress = false;
  private timer: NodeJS.Timeout | undefined;
  private stopped = false;

  constructor(
    @Inject(LEDGER_WATCH_CONFIG) private readonly config: LedgerWatchConfig,
    @Inject(LEDGER_VERIFIER) private readonly verifier: VerifierPort | undefined,
    private readonly status: LedgerStatus,
  ) {}

  /** False when no verifier login is configured: the watch is off, readiness has no ledger check and the append gate never closes. */
  get enabled(): boolean {
    return this.verifier !== undefined;
  }

  async onApplicationBootstrap(): Promise<void> {
    if (!this.verifier) return;
    await this.checkAtStart(this.verifier);
    this.pass = this.runFullPass('background');
    this.armTimer();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    this.abort.abort(); // a walk in progress stops at its next batch instead of holding shutdown
    await this.pass?.catch(() => undefined); // intentional: the pass logs its own failure
    await this.running?.catch(() => undefined); // intentional: the holder reports its own failure
    await this.verifier?.close();
  }

  /** Resolves when the walk that began at start has finished (tests await this instead of sleeping). */
  async idle(): Promise<void> {
    await this.pass?.catch(() => undefined); // intentional: the pass logs its own failure
  }

  /**
   * An admin's check of one tenant, now. Refused (503, try again) while another verification is running in this process.
   * A `failed` answer latches the instance just as the background walk would: an admin who found damage found the same damage.
   */
  async verifyNow(tenantId: string, full: boolean): Promise<VerifyResult> {
    if (!this.verifier) throw AppException.pipelineMisconfigured();
    const verifier = this.verifier;
    const outcome = await this.tryHold(async () => {
      const result = await verifier.verify(tenantId, {
        mode: full ? 'full' : 'tail', budgetMs: this.config.onDemandBudgetMs, recordCheckpoint: this.status.compromised === null, signal: this.abort.signal,
      });
      this.note(result, 'on-demand');
      return result;
    });
    if (outcome === BUSY) throw AppException.ledgerCheckBusy();
    return outcome;
  }

  // ---- start ----

  private async checkAtStart(verifier: VerifierPort): Promise<void> {
    const deadline = Date.now() + this.config.startupBudgetMs;
    let outcome: TailState = 'ok';
    let checked = 0;
    try {
      const tenants = await verifier.tenants();
      for (const tenantId of tenants) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          outcome = outcome === 'failed' ? 'failed' : 'incomplete';
          break;
        }
        const result = await this.queued(() => verifier.verify(tenantId, {
          mode: 'tail', budgetMs: remaining, fullWalkAtOrBelow: this.config.fullWalkAtOrBelowEvents, signal: this.abort.signal,
        }));
        this.note(result, 'startup');
        checked += 1;
        if (result.status === 'failed') outcome = 'failed';
        else if (result.status === 'incomplete' && outcome !== 'failed') outcome = 'incomplete';
      }
    } catch (error) {
      // The check could not run at all (login, network, missing tables): nothing is known about the record log, which is not "fine".
      this.logger.error({ event: 'ledger-verification-error', source: 'startup', error: describe(error), message: 'The record log could not be checked at start.' });
      if (outcome !== 'failed') outcome = 'incomplete';
    }
    this.status.setTail(outcome);
    if (outcome === 'ok') return;

    const finding = this.status.compromised;
    const summary = finding ? ` (${finding.kind}${finding.seq === null ? '' : ` at sequence ${finding.seq}`})` : '';
    if (this.config.production) {
      throw new Error(`The record log did not pass its check at start: ${outcome}${summary}. Production does not start until it does (docs/ops/ledger-watch.md).`);
    }
    this.logger.warn({ event: 'ledger-startup-check', outcome, tenantsChecked: checked, message: `The record log did not pass its check at start (${outcome}); continuing because this is not production.` });
  }

  // ---- background and scheduled full walks ----

  private runFullPass(source: 'background' | 'scheduled'): Promise<void> {
    const verifier = this.verifier;
    if (!verifier || this.stopped) return Promise.resolve();
    if (this.passInProgress) {
      this.logger.warn({ event: 'ledger-verification-skipped', source, message: 'A full check is still running; this one was skipped.' });
      return this.pass ?? Promise.resolve();
    }
    this.passInProgress = true;
    this.status.setFullRunning(true);
    const done = (async () => {
      let allOk = true;
      try {
        for (const tenantId of await verifier.tenants()) {
          if (this.stopped) {
            allOk = false;
            break;
          }
          const result = await this.queued(() => verifier.verify(tenantId, {
            mode: 'full', budgetMs: this.config.fullBudgetMs, recordCheckpoint: this.status.compromised === null, signal: this.abort.signal,
          }));
          this.note(result, source);
          if (result.status !== 'ok') allOk = false;
        }
      } catch (error) {
        allOk = false;
        this.logger.error({ event: 'ledger-verification-error', source, error: describe(error), message: 'A full check of the record log could not run.' });
      } finally {
        this.status.setFullRunning(false);
        this.passInProgress = false;
      }
      if (allOk && !this.stopped) this.status.markFullCompleted();
    })();
    return done;
  }

  private armTimer(): void {
    if (this.config.fullIntervalMs <= 0 || this.stopped) return;
    const delay = Math.round(this.config.fullIntervalMs * (0.9 + Math.random() * 0.2));
    this.timer = setTimeout(() => {
      this.pass = this.runFullPass('scheduled');
      void this.pass.finally(() => this.armTimer());
    }, delay);
    this.timer.unref(); // the timer alone must never keep the process alive
  }

  // ---- shared ----

  /** One verification at a time in this process. A background caller queues behind the current one... */
  private async queued<T>(work: () => Promise<T>): Promise<T> {
    while (this.running) await this.running.catch(() => undefined); // intentional: the holder reports its own failure
    return this.hold(work);
  }

  /** ...and a caller who is waiting on a person (the admin endpoint) is told it is busy instead. */
  private async tryHold<T>(work: () => Promise<T>): Promise<T | typeof BUSY> {
    if (this.running) return BUSY;
    return this.hold(work);
  }

  /** Takes the slot synchronously (before the first await), so two callers can never both find it free. */
  private async hold<T>(work: () => Promise<T>): Promise<T> {
    const mine = work();
    this.running = mine;
    try {
      return await mine;
    } finally {
      if (this.running === mine) this.running = null;
    }
  }

  /** Logs what a verification found and latches the instance on damage. */
  private note(result: VerifyResult, source: VerifySource): void {
    if (result.status === 'failed') {
      const first = result.failures[0]!;
      this.status.latch({ tenantId: result.tenantId, kind: first.kind, seq: first.seq, source, at: new Date() });
      this.logger.error({
        event: 'ledger-compromised', source, tenantId: result.tenantId, mode: result.mode, eventsChecked: result.eventsChecked,
        failures: result.failures.slice(0, 10).map(({ kind, seq }) => ({ kind, seq })), message: 'The record log failed verification. Records are no longer written by this instance.',
      });
    } else if (result.status === 'incomplete' && !this.abort.signal.aborted) {
      // (A walk stopped because the application is shutting down is not worth a line: the next start walks again.)
      this.logger.warn({
        event: 'ledger-verification-incomplete', source, tenantId: result.tenantId, mode: result.mode, eventsChecked: result.eventsChecked,
        message: 'A check of the record log ran out of time or size before it finished; nothing was recorded as verified.',
      });
    }
  }
}

/** An error reduced to its class and database code: messages from the driver can carry host names or user names. */
function describe(error: unknown): string {
  const code = (error as { code?: unknown })?.code;
  return `${error instanceof Error ? error.name : 'Error'}${typeof code === 'string' ? ` ${code}` : ''}`;
}
