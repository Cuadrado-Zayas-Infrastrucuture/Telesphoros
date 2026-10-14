import type { JobQueue } from '@telesphoros/jobs';
import type { Logger } from './log';

/**
 * Enqueues the recurring jobs. Every worker runs one; the database makes a slot idempotent (one job per organization per slot, keyed by the slot), so several
 * schedulers - or a restart in the middle of a slot - never double-enqueue and a stopped worker leaves no backlog of missed slots.
 */
export class Scheduler {
  private timer: NodeJS.Timeout | undefined;
  private inFlight: Promise<void> = Promise.resolve();

  constructor(private readonly queue: JobQueue, private readonly everySeconds: number, private readonly log: Logger) {}

  start(): void {
    if (this.timer) throw new Error('The scheduler is already started.');
    this.timer = setInterval(() => void this.tick(), this.everySeconds * 1000);
    void this.tick();
  }

  tick(): Promise<void> {
    this.inFlight = this.inFlight.then(async () => {
      try {
        const added = await this.queue.scheduleTick();
        if (added > 0) this.log('info', 'jobs-scheduled', { count: added });
      } catch {
        this.log('error', 'schedule-tick-failed', { code: 'queue-unavailable' });
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
