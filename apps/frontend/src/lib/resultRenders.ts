import { RENDER_BATCH_MAX, type ResultRenderEvent } from '@telesphoros/shared-types';
// Type only, as in resultAcknowledgements.ts: importing `./api` at run time would pull upload code into this chunk.
import type { ApiFetch } from './api';

/**
 * Spec 019 D02b: the delivery of render events (plan P4). Exposure is explicitly lossy analytics: the first exposure of an episode is sent at once,
 * durations in batches; retries are bounded; the buffer holds ids and times only, for a short time; on page hide the queue is flushed with
 * `fetch(..., { keepalive: true })` (never `sendBeacon`, which cannot carry the bearer token and gives no receipt). A failure is never shown to the
 * clinician and never blocks reading: a missing event means "unknown". One queue per signed-in session, shared by every row on the page.
 */

const PATH = '/api/v1/result-renders';
/** Durations wait this long for company before they are sent. */
export const RENDER_FLUSH_MS = 5_000;
/** A batch that got no answer (or a 408, 429 or 5xx) is sent at most this many times, then dropped. */
export const RENDER_MAX_ATTEMPTS = 3;
/** Retry delays after the first and second failure. */
export const RENDER_RETRY_MS = [1_000, 4_000] as const;
/** The most events held at once; the oldest go first beyond it. */
export const RENDER_BUFFER_MAX = 200;

interface Held {
  event: ResultRenderEvent;
  attempts: number;
}

export class RenderQueue {
  private held: Held[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private sending = false;
  /** An exposure arrived while a batch was on its way: send it as soon as that batch is answered, not after the batching delay. */
  private urgent = false;
  /** Set from page hide until the page is visible again: anything recorded meanwhile goes at once, with keepalive. */
  private leaving = false;
  private readonly onPageHide = () => {
    this.leaving = true;
    void this.flush(true);
  };
  private readonly onVisibility = () => {
    if (document.visibilityState === 'hidden') void this.flush(true);
    else this.leaving = false;
  };
  private listeners = 0;
  /**
   * The API answered that the route is switched off (503 `PIPELINE_DISABLED`): an environment that does not record renders. Nothing more is held
   * or sent for this session, so a result view that mounts the capture everywhere does not send a refused request for every row (specs/038).
   */
  private unavailable = false;

  constructor(private readonly apiFetch: ApiFetch) {}

  /** Page-lifecycle flushing, while at least one row is attached. */
  attach(): () => void {
    if (this.listeners++ === 0) {
      window.addEventListener('pagehide', this.onPageHide);
      document.addEventListener('visibilitychange', this.onVisibility);
    }
    return () => {
      if (--this.listeners === 0) {
        window.removeEventListener('pagehide', this.onPageHide);
        document.removeEventListener('visibilitychange', this.onVisibility);
      }
    };
  }

  /** `now` for an exposure (P4: sent promptly) and for anything recorded as the page hides; `batch` for durations. */
  enqueue(event: ResultRenderEvent, when: 'now' | 'batch'): void {
    if (this.unavailable) return;
    this.held.push({ event, attempts: 0 });
    if (this.held.length > RENDER_BUFFER_MAX) this.held.splice(0, this.held.length - RENDER_BUFFER_MAX);
    if (when === 'now') {
      this.urgent = true;
      void this.flush(this.leaving || document.visibilityState === 'hidden');
    } else this.schedule(RENDER_FLUSH_MS);
  }

  /** Events not yet confirmed by the server (for tests and diagnostics: ids and times only). */
  pending(): readonly ResultRenderEvent[] {
    return this.held.map((h) => h.event);
  }

  private schedule(ms: number) {
    if (this.timer === undefined) this.timer = setTimeout(() => void this.flush(false), ms);
  }

  /**
   * Sends up to one batch. One request at a time, so an exposure always reaches the server before its durations; the exception is the page hiding,
   * when what is left goes at once with `keepalive` (the page may not live to send it later).
   */
  async flush(keepalive: boolean): Promise<void> {
    if (this.sending && !keepalive) return;
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    const batch = this.held.splice(0, RENDER_BATCH_MAX);
    if (batch.length === 0) return;
    this.urgent = false;
    const wasSending = this.sending;
    this.sending = true;
    let outcome: 'stored' | 'retry' | 'drop';
    try {
      const response = await this.apiFetch(PATH, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sentAt: new Date().toISOString(), events: batch.map((h) => h.event) }),
        keepalive,
      });
      // A refusal (400, 403, 404, 409) stores nothing and would be refused again: it is dropped. No answer worth trusting is retried.
      outcome = response.ok ? 'stored' : response.status >= 500 || response.status === 408 || response.status === 429 ? 'retry' : 'drop';
      if (response.status === 503 && (await switchedOff(response))) {
        // Not an outage: a setting. Retrying cannot help, and neither can the next row's events.
        this.unavailable = true;
        this.held = [];
        outcome = 'drop';
      }
    } catch {
      outcome = 'retry'; // no answer: the batch may or may not be stored, and a retry stores nothing twice (the server skips stored events)
    }
    if (!wasSending) this.sending = false;
    if (outcome === 'retry') {
      const again = batch.filter((h) => ++h.attempts < RENDER_MAX_ATTEMPTS);
      this.held.unshift(...again);
      if (again.length > 0) this.schedule(RENDER_RETRY_MS[Math.min(again[0]!.attempts, RENDER_RETRY_MS.length) - 1]!);
    }
    if (this.held.length > 0) {
      if (outcome !== 'retry' && (this.urgent || this.held.length >= RENDER_BATCH_MAX)) void this.flush(keepalive);
      else this.schedule(RENDER_FLUSH_MS);
    }
  }
}

/** Whether a 503 says the route is switched off, by the API's fixed error code. Any other body, or none, is an ordinary outage. */
async function switchedOff(response: Response): Promise<boolean> {
  try {
    const body = (await response.json()) as { error?: { code?: unknown } } | null;
    return body?.error?.code === 'PIPELINE_DISABLED';
  } catch {
    return false;
  }
}

const queues = new WeakMap<ApiFetch, RenderQueue>();
/** The one queue of this signed-in session (`apiFetch` changes with the person, so a new person never inherits another's events). */
export function renderQueueFor(apiFetch: ApiFetch): RenderQueue {
  let queue = queues.get(apiFetch);
  if (!queue) {
    queue = new RenderQueue(apiFetch);
    queues.set(apiFetch, queue);
  }
  return queue;
}
