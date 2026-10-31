import type { Logger } from './log';

/**
 * A task the worker repeats on a timer, one run at a time (a slow run is not overlapped by the next tick). Two use it:
 *
 * - the scheduler: asks the database to enqueue the recurring jobs. Every worker runs one; the database makes a slot idempotent (one job per organization per slot,
 *   keyed by the slot), so several schedulers - or a restart in the middle of a slot - never double-enqueue and a stopped worker leaves no backlog of missed slots.
 * - the outbox relay: asks the database to turn pending outbox events into jobs. Concurrent relays take different events, and an event becomes its job and is marked
 *   in one transaction, so a crash cannot lose or duplicate one.
 * - the capability sweep (spec 026): asks the database to remove expired capabilities. It logs every run, one that removed nothing included, because its
 *   "sweep is stale" alarm counts those lines; the others log only when they did something.
 */
/** What a run did: a count, or a count and a short outcome code for the log. */
export type TickReport = number | { count: number; outcome: string };

export class Ticker {
  private timer: NodeJS.Timeout | undefined;
  private inFlight: Promise<void> = Promise.resolve();

  constructor(
    private readonly name: string,
    /** Returns how many things it did (a count for the log), with an outcome code when it has one. */
    private readonly run: () => Promise<TickReport>,
    private readonly everySeconds: number,
    private readonly log: Logger,
    private readonly options: { logEveryRun?: boolean } = {},
  ) {}

  start(): void {
    if (this.timer) throw new Error(`The ${this.name} is already started.`);
    this.timer = setInterval(() => void this.tick(), this.everySeconds * 1000);
    void this.tick();
  }

  tick(): Promise<void> {
    this.inFlight = this.inFlight.then(async () => {
      try {
        const report = await this.run();
        const { count, outcome } = typeof report === 'number' ? { count: report, outcome: undefined } : report;
        if (count > 0 || this.options.logEveryRun) this.log('info', `${this.name}-ran`, outcome === undefined ? { count } : { count, outcome });
      } catch {
        this.log('error', `${this.name}-failed`, { code: 'queue-unavailable' });
      }
    });
    return this.inFlight;
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.inFlight;
  }
}
