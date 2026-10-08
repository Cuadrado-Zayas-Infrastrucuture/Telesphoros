import { LedgerCompromisedError } from './ledger-types';
import type { FailureKind } from './verifier';

/** The only thing a write path needs from the ledger watch: a way to refuse. */
export interface LedgerGate {
  /** Throws `LedgerCompromisedError` while the record log is latched as damaged. Cheap and side-effect free. */
  assertOpen(): void;
}

export type VerifySource = 'startup' | 'background' | 'scheduled' | 'on-demand';

/** What was found, without any value from a record: which tenant, what kind of break, at which sequence number. */
export interface Compromise {
  tenantId: string;
  kind: FailureKind;
  seq: string | null;
  source: VerifySource;
  at: Date;
}

export type TailState = 'not-run' | 'ok' | 'failed' | 'incomplete';

/** What `/ready` shows for the ledger: `up`, `verifying` (usable, a full check is still running or has not yet finished), or `down`. */
export type LedgerReadiness = 'up' | 'verifying' | 'down';

/**
 * In-process state of the ledger watch (specification 6.6 and 6.7). One per process, shared by the monitor (which writes it), the readiness
 * check and the append gate (which read it). Plain memory on purpose: readiness cannot time out on the database, and nothing here can be
 * cleared except by restarting the process after an investigation.
 *
 * Two instances may briefly disagree (each runs its own walks and latches itself); a single-instance pilot does not notice.
 */
export class LedgerStatus implements LedgerGate {
  private compromise: Compromise | null = null;
  private tail: TailState = 'not-run';
  private fullRunning = false;
  private fullCompleted = false;

  /** Keeps the FIRST finding: it is the one an investigator wants, and later ones are usually its consequences. */
  latch(finding: Compromise): void {
    this.compromise ??= finding;
  }

  get compromised(): Compromise | null {
    return this.compromise;
  }

  assertOpen(): void {
    if (this.compromise) throw new LedgerCompromisedError();
  }

  setTail(state: TailState): void {
    this.tail = state;
  }

  get tailState(): TailState {
    return this.tail;
  }

  setFullRunning(running: boolean): void {
    this.fullRunning = running;
  }

  /** A full verification of every tenant finished `ok`. */
  markFullCompleted(): void {
    this.fullCompleted = true;
  }

  readiness(): LedgerReadiness {
    if (this.compromise || this.tail !== 'ok') return 'down';
    return this.fullRunning || !this.fullCompleted ? 'verifying' : 'up';
  }
}
