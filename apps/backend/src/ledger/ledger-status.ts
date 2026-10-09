import { LedgerCompromisedError } from './ledger-types';
import type { FailureKind } from './verifier';

/** The only thing a write path needs from the ledger watch: a way to refuse, for the tenant it is about to write for. */
export interface LedgerGate {
  /** Throws `LedgerCompromisedError` while that tenant's record log is contained (or a global hold is open). Cheap and side-effect free. */
  assertOpen(tenantId: string): void;
}

export type VerifySource = 'startup' | 'background' | 'scheduled' | 'on-demand';

/** What was found, without any value from a record: which tenant, what kind of break, at which sequence number. */
export interface Compromise {
  /** `null` for a global hold, which is about every tenant. */
  tenantId: string | null;
  kind: FailureKind | 'manual-hold';
  seq: string | null;
  source: VerifySource | 'manual';
  at: Date;
}

/** An incident as the database holds it (see `LedgerVerifier.openIncidents`). */
export interface OpenIncident {
  id: string;
  scope: 'tenant' | 'global';
  tenantId: string | null;
  kind: Compromise['kind'];
  seq: string | null;
  source: Compromise['source'];
  detectedAt: Date;
}

export type TailState = 'not-run' | 'ok' | 'failed' | 'incomplete';

/**
 * What `/ready` shows for the ledger: `up`; `verifying` (usable, a full check is still running or has not yet finished); `contained` (usable:
 * at least one tenant's record log is stopped, the others are not); or `down` (a global hold, or the check at start did not pass).
 */
export type LedgerReadiness = 'up' | 'verifying' | 'contained' | 'down';

interface Entry {
  finding: Compromise;
  /** The database has been told. Until it has, this process keeps refusing on its own, and the monitor retries. */
  recorded: boolean;
}

/**
 * In-process view of the ledger watch (specification 6.6 and 6.7). One per process, shared by the monitor (which writes it), the readiness
 * check and the append gate (which read it). Plain memory on purpose: readiness cannot time out on the database.
 *
 * It is a FAST PATH and a mirror, not the authority. The authority is the database (migration 0011): `ledger_append` refuses a contained
 * tenant's write inside its own transaction, whichever task made it. So a task that has not yet noticed a sibling's finding still cannot
 * write to the damaged chain, and a restart changes nothing: the monitor reads the open incidents again and mirrors them here.
 * Containment is per tenant; only a global hold (set by a person) stops every tenant.
 */
export class LedgerStatus implements LedgerGate {
  private readonly contained = new Map<string, Entry>();
  private globalHold: Compromise | null = null;
  private tail: TailState = 'not-run';
  private fullRunning = false;
  private fullCompleted = false;

  /** This process found damage. Keeps the FIRST finding per tenant: it is the one an investigator wants, and later ones are usually its consequences. */
  latch(finding: Compromise): void {
    if (finding.tenantId === null || this.contained.has(finding.tenantId)) return;
    this.contained.set(finding.tenantId, { finding, recorded: false });
  }

  /** The database now holds this process's finding. */
  markRecorded(tenantId: string): void {
    const entry = this.contained.get(tenantId);
    if (entry) entry.recorded = true;
  }

  /** Findings made here that the database has not been told about yet. */
  unrecorded(): Compromise[] {
    return [...this.contained.values()].filter((e) => !e.recorded).map((e) => e.finding);
  }

  /**
   * Mirrors the database: exactly the open incidents are contained, plus any finding of this process that is not recorded yet (it must not be
   * forgotten just because the database has not heard of it). An incident a person has cleared stops being contained here.
   */
  syncOpen(open: OpenIncident[]): void {
    const tenantIncidents = new Map<string, OpenIncident>();
    let hold: OpenIncident | null = null;
    for (const incident of open) {
      if (incident.scope === 'global') hold ??= incident;
      else if (incident.tenantId !== null && !tenantIncidents.has(incident.tenantId)) tenantIncidents.set(incident.tenantId, incident);
    }
    for (const [tenantId, entry] of [...this.contained]) {
      if (!tenantIncidents.has(tenantId) && entry.recorded) this.contained.delete(tenantId);
    }
    for (const [tenantId, incident] of tenantIncidents) {
      const existing = this.contained.get(tenantId);
      if (existing) existing.recorded = true;
      else this.contained.set(tenantId, { finding: { tenantId, kind: incident.kind, seq: incident.seq, source: incident.source, at: incident.detectedAt }, recorded: true });
    }
    this.globalHold = hold ? { tenantId: null, kind: hold.kind, seq: hold.seq, source: hold.source, at: hold.detectedAt } : null;
  }

  /** This tenant has an incident of its own (a global hold does not count: it is about everyone). */
  hasIncident(tenantId: string): boolean {
    return this.contained.has(tenantId);
  }

  /** Writes for this tenant are refused: its own incident, or a global hold. */
  isContained(tenantId: string): boolean {
    return this.globalHold !== null || this.contained.has(tenantId);
  }

  /** The tenants whose record log is stopped here (not a global hold). */
  containedTenants(): string[] {
    return [...this.contained.keys()];
  }

  get hold(): Compromise | null {
    return this.globalHold;
  }

  /** The first open finding (a global hold first), or null. */
  get compromised(): Compromise | null {
    return this.globalHold ?? this.contained.values().next().value?.finding ?? null;
  }

  finding(tenantId: string): Compromise | null {
    return this.contained.get(tenantId)?.finding ?? null;
  }

  assertOpen(tenantId: string): void {
    if (this.isContained(tenantId)) throw new LedgerCompromisedError();
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

  /** A full verification of every tenant finished `ok` (a contained tenant's expected failure does not count against it). */
  markFullCompleted(): void {
    this.fullCompleted = true;
  }

  readiness(): LedgerReadiness {
    if (this.globalHold || this.tail !== 'ok') return 'down';
    if (this.contained.size > 0) return 'contained';
    return this.fullRunning || !this.fullCompleted ? 'verifying' : 'up';
  }
}
