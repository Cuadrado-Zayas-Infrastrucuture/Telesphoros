import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { AppException } from '../common/app-exception';
import { type Compromise, LedgerStatus, type OpenIncident, type TailState, type VerifySource } from './ledger-status';
import type { VerifyOptions, VerifyResult } from './verifier';

export const LEDGER_VERIFIER = Symbol('LEDGER_VERIFIER');
export const LEDGER_WATCH_CONFIG = Symbol('LEDGER_WATCH_CONFIG');

/** What the monitor needs from a verifier (the real one is `LedgerVerifier`; unit tests pass a fake). */
export interface VerifierPort {
  tenants(): Promise<string[]>;
  verify(tenantId: string, options?: VerifyOptions): Promise<VerifyResult>;
  /** Tells the database a verification found a tenant's record log damaged; returns the incident id. Idempotent. */
  recordIncident(finding: Pick<Compromise, 'tenantId' | 'kind' | 'seq' | 'source'>): Promise<string>;
  /** Every incident no clearance names. */
  openIncidents(): Promise<OpenIncident[]>;
  close(): Promise<void>;
}

export interface LedgerWatchConfig {
  /** Production refuses to start when the checks at start fail or do not finish in time; other environments warn and continue. */
  production: boolean;
  /**
   * The checkpoint checks at start (every tenant) may take this long IN TOTAL. Full walks of small chains then get half as much again
   * (`STARTUP_FULL_WALK_SHARE`), so the whole start check is bounded by one and a half times this.
   */
  startupBudgetMs: number;
  /** Time between full walks. 0 turns the timer off. Each delay is jittered by up to 10% either way. */
  fullIntervalMs: number;
  /** Time one tenant's full walk may take in the background or on the timer. */
  fullBudgetMs: number;
  /** Time one check asked for over HTTP may take. */
  onDemandBudgetMs: number;
  /**
   * A chain of at most this many events gets a FULL walk at start even when a checkpoint exists (a checkpoint is a shortcut, not a control),
   * as far as the full-walk allowance at start reaches. The walks that do not fit are left to the background pass, which starts right after.
   */
  fullWalkAtOrBelowEvents: number;
  /** How often the open incidents are read again, so a sibling task's finding (or a person's clearance) reaches this process's view. 0 turns it off. */
  incidentPollMs: number;
}

/** Measured in slice 5B-3.3c (docs/ops/ledger-watch.md): these are the defaults the environment settings are layered over. */
export const FULL_WALK_AT_OR_BELOW_EVENTS = 50_000;
export const FULL_BUDGET_MS = 15 * 60_000;
export const ON_DEMAND_BUDGET_MS = 30_000;
export const INCIDENT_POLL_MS = 60_000;
/** The share of `startupBudgetMs` that full walks of small chains may use at start, counted after the checkpoint checks. */
export const STARTUP_FULL_WALK_SHARE = 0.5;

const BUSY = Symbol('busy');

/**
 * The ledger watch (specification 6.6 and 6.7). It owns the verifier connection and the in-process `LedgerStatus`:
 *
 *   1. At start, each tenant that is not already contained has its chain checked from its latest checkpoint within one total budget
 *      (a tenant with no checkpoint is walked from the start, which that budget must also cover). Production refuses to start when a
 *      tenant fails that check and is not yet contained (the finding is recorded first, so the next start sees it as contained), or when
 *      the check cannot finish; other environments log and carry on. A tenant already contained is listed in the log, not re-judged.
 *      Then, within half as much time again, chains of at most `fullWalkAtOrBelowEvents` are walked in full, because a checkpoint is a
 *      shortcut and not an independent control. Full walks that do not fit are skipped and logged, never a reason to refuse the start:
 *      the background full pass (2.) begins right after start and covers them, and a failure it finds contains the tenant as in 3.
 *   2. Right after start, and then on a timer, every tenant's whole chain is walked and a checkpoint is recorded on success.
 *   3. A `failed` walk, from any of these or from the admin endpoint, CONTAINS that tenant: the finding is recorded in the database
 *      (the verifier's `recordIncident`), where `ledger_append` refuses every write for the tenant in every task, and is mirrored in this process's
 *      `LedgerStatus`. Other tenants keep working; reads continue. A person clears the incident (a runbook step, never an API) after an
 *      investigation, and only a full walk that began after the incident has passed.
 *   4. The open incidents are read at start, before each full walk and on a short timer, so a sibling task's finding or a person's
 *      clearance reaches this process even if it never walked that tenant itself.
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
  private pollTimer: NodeJS.Timeout | undefined;
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
    this.armPoll();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    clearTimeout(this.pollTimer);
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
   * A `failed` answer contains the tenant just as the background walk would: an admin who found damage found the same damage.
   */
  async verifyNow(tenantId: string, full: boolean): Promise<VerifyResult> {
    if (!this.verifier) throw AppException.pipelineMisconfigured();
    const verifier = this.verifier;
    const outcome = await this.tryHold(async () => {
      const result = await verifier.verify(tenantId, {
        mode: full ? 'full' : 'tail', budgetMs: this.config.onDemandBudgetMs, recordCheckpoint: true, signal: this.abort.signal,
      });
      await this.note(result, 'on-demand');
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
    await this.syncIncidents(); // what the database already holds (a sibling's findings, a person's global hold)
    const knownBefore = this.status.containedTenants().length;
    if (knownBefore > 0 || this.status.hold) {
      this.logger.warn({ event: 'ledger-contained-at-start', containedTenants: knownBefore, globalHold: this.status.hold !== null, message: 'Record logs are already contained; this instance starts, and does not re-judge them. Their full walk goes on in the background.' });
    }
    try {
      const tenants = await verifier.tenants();
      // Phase A, the check that decides whether to start: every tenant from its latest checkpoint, within the one total budget. Cheap for a
      // tenant with a checkpoint; a tenant without one is walked from the start (mode `full`), which is why the budget can still run out.
      const walkedInFull = new Set<string>();
      for (const tenantId of tenants) {
        if (this.status.hasIncident(tenantId)) continue; // already known and recorded: not judged again here, its full walk goes on in the background
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          outcome = outcome === 'failed' ? 'failed' : 'incomplete';
          break;
        }
        const result = await this.queued(() => verifier.verify(tenantId, { mode: 'tail', budgetMs: remaining, signal: this.abort.signal }));
        await this.note(result, 'startup');
        checked += 1;
        if (result.status === 'failed') outcome = 'failed';
        else if (result.status === 'incomplete' && outcome !== 'failed') outcome = 'incomplete';
        else if (result.status === 'ok' && result.mode === 'full') walkedInFull.add(tenantId);
      }
      // Phase B, strengthening only: full walks of small chains, within their own allowance. It runs only when phase A found nothing wrong
      // (otherwise the start is already refused or the tenant already contained), and it cannot make the start incomplete: what it does not
      // reach is left to the background pass.
      if (outcome === 'ok' && (await this.fullWalksAtStart(verifier, tenants, walkedInFull)) === 'failed') outcome = 'failed';
    } catch (error) {
      // The check could not run at all (login, network, missing tables): nothing is known about the record log, which is not "fine".
      this.logger.error({ event: 'ledger-verification-error', source: 'startup', error: describe(error), message: 'The record log could not be checked at start.' });
      if (outcome !== 'failed') outcome = 'incomplete';
    }
    this.status.setTail(outcome);
    if (outcome === 'ok') return;

    const finding = [...this.status.containedTenants()].map((t) => this.status.finding(t)).find((f) => f?.source === 'startup') ?? this.status.compromised;
    const summary = finding ? ` (${finding.kind}${finding.seq === null ? '' : ` at sequence ${finding.seq}`})` : '';
    if (this.config.production) {
      throw new Error(`The record log did not pass its check at start: ${outcome}${summary}. Production does not start until it does (docs/ops/ledger-watch.md).`);
    }
    this.logger.warn({ event: 'ledger-startup-check', outcome, tenantsChecked: checked, message: `The record log did not pass its check at start (${outcome}); continuing because this is not production.` });
  }

  /**
   * Walks, in full, each tenant whose chain is at most `fullWalkAtOrBelowEvents` long, in the tenants' order, while the allowance lasts.
   * A walk that the allowance cuts short, and every tenant after it, is left to the background pass and counted in the log. Only damage
   * counts here: an unfinished walk is neither damage nor a reason to refuse the start.
   */
  private async fullWalksAtStart(verifier: VerifierPort, tenants: readonly string[], alreadyWalked: ReadonlySet<string>): Promise<'ok' | 'failed'> {
    const deadline = Date.now() + Math.floor(this.config.startupBudgetMs * STARTUP_FULL_WALK_SHARE);
    let failed = false;
    let walked = 0;
    let left = 0;
    for (const tenantId of tenants) {
      if (this.status.hasIncident(tenantId) || alreadyWalked.has(tenantId)) continue; // contained, or already walked in full by phase A
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        left += 1;
        continue;
      }
      const result = await this.queued(() => verifier.verify(tenantId, {
        mode: 'tail', budgetMs: remaining, fullWalkAtOrBelow: this.config.fullWalkAtOrBelowEvents, signal: this.abort.signal,
      }));
      if (result.status === 'incomplete') {
        left += 1; // the allowance ended inside this walk (a checkpoint check of a larger chain was already done in phase A)
      } else {
        await this.note(result, 'startup');
        if (result.status === 'failed') failed = true;
        else if (result.mode === 'full') walked += 1;
      }
    }
    if (left > 0 && !this.abort.signal.aborted) {
      this.logger.warn({
        event: 'ledger-startup-full-walks-deferred', fullWalks: walked, deferred: left,
        message: 'Some full walks of small record logs did not fit in the time allowed at start. They were checked from their checkpoint, and the background full pass, which starts now, walks them in full.',
      });
    }
    return failed ? 'failed' : 'ok';
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
        await this.syncIncidents();
        for (const tenantId of await verifier.tenants()) {
          if (this.stopped) {
            allOk = false;
            break;
          }
          const result = await this.queued(() => verifier.verify(tenantId, {
            // A checkpoint is a true statement about the tenant that was walked, so it is recorded for every tenant that passes, a contained
            // one included: it is the evidence a person needs to clear the incident.
            mode: 'full', budgetMs: this.config.fullBudgetMs, recordCheckpoint: true, signal: this.abort.signal,
          }));
          await this.note(result, source);
          // A contained tenant that still fails is expected and already reported; it must not keep the instance "verifying" forever.
          if (result.status !== 'ok' && !(result.status === 'failed' && this.status.hasIncident(tenantId))) allOk = false;
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

  private armPoll(): void {
    if (this.config.incidentPollMs <= 0 || this.stopped) return;
    this.pollTimer = setTimeout(() => {
      void this.syncIncidents().finally(() => this.armPoll());
    }, this.config.incidentPollMs);
    this.pollTimer.unref(); // the timer alone must never keep the process alive
  }

  // ---- shared ----

  /**
   * Brings this process's view in line with the database: first tells it about any finding made here that it has not heard (a database that
   * was unreachable when the damage was found), then mirrors the open incidents. It never throws: when the database cannot be read the
   * process keeps what it knows, and the database still refuses writes on its own.
   */
  private async syncIncidents(): Promise<void> {
    const verifier = this.verifier;
    if (!verifier) return;
    try {
      for (const finding of this.status.unrecorded()) await this.record(finding);
      this.status.syncOpen(await verifier.openIncidents());
    } catch (error) {
      this.logger.warn({ event: 'ledger-incident-sync-failed', error: describe(error), message: 'The open incidents could not be read; this instance keeps what it knows, and the database still refuses writes for contained tenants.' });
    }
  }

  /** Writes a finding of this process into the database. A failure is logged and retried by the next sync; it never hides the finding. */
  private async record(finding: Compromise): Promise<void> {
    const verifier = this.verifier;
    if (!verifier || finding.tenantId === null) return;
    try {
      await verifier.recordIncident({ tenantId: finding.tenantId, kind: finding.kind, seq: finding.seq, source: finding.source });
      this.status.markRecorded(finding.tenantId);
    } catch (error) {
      this.logger.error({ event: 'ledger-incident-record-failed', tenantId: finding.tenantId, error: describe(error), message: 'A finding could not be recorded in the database; this instance refuses writes for the tenant meanwhile and retries.' });
    }
  }

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

  /** Logs what a verification found and, on damage, contains the tenant: latched here at once, recorded in the database for every task. */
  private async note(result: VerifyResult, source: VerifySource): Promise<void> {
    if (result.status === 'failed') {
      const first = result.failures[0]!;
      const alreadyContained = this.status.hasIncident(result.tenantId);
      const finding: Compromise = { tenantId: result.tenantId, kind: first.kind, seq: first.seq, source, at: new Date() };
      if (!alreadyContained) {
        this.status.latch(finding); // before the first await: this process refuses at once, whatever the database call does
        this.logger.error({
          event: 'ledger-compromised', source, tenantId: result.tenantId, mode: result.mode, eventsChecked: result.eventsChecked,
          failures: result.failures.slice(0, 10).map(({ kind, seq }) => ({ kind, seq })), message: 'The record log of this tenant failed verification. Records are no longer written for it.',
        });
        await this.record(finding);
      } else {
        // The tenant is already contained and reported (the alarm fired on the first finding): a repeat is a warning, not a second page.
        this.logger.warn({
          event: 'ledger-incident-still-open', source, tenantId: result.tenantId, mode: result.mode, eventsChecked: result.eventsChecked,
          failures: result.failures.slice(0, 10).map(({ kind, seq }) => ({ kind, seq })), message: 'A contained tenant still fails verification.',
        });
      }
    } else if (result.status === 'incomplete' && result.incompleteReason === 'size' && !this.abort.signal.aborted) {
      // Not damage and not a wait: this chain is longer than one verification will walk, so it repeats every pass until the limit or the chain is dealt with.
      this.logger.error({
        event: 'ledger-chain-over-size', source, tenantId: result.tenantId, mode: result.mode, eventsChecked: result.eventsChecked,
        message: 'The record log of this tenant is longer than one verification walks, so it cannot be fully verified. Nothing was recorded as verified and nothing is contained.',
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
