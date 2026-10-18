import { emptyCounters, type Counters, type Observation, type Profile, type Run } from './contracts';

export interface Reservation { run: Run; tenantWindow: string; fleetWindow: string; tokensReserved: number; costReserved: number; active: boolean; counters: Counters; attempts: Set<string> }
// Synchronous operations are atomic only within this memory instance. Not a DB adapter.
export class SyntheticBudgets {
  private reservations = new Map<string, Reservation>();
  constructor(private availableTokens = 28160) {}
  reserve(run: Run, profile: Profile): boolean {
    if (this.reservations.has(run.id)) return false;
    const active = [...this.reservations.values()].filter(r => r.active);
    if (active.filter(r => r.run.tenantId === run.tenantId).length >= profile.budget.tenantActive || active.length >= profile.budget.fleetActive || this.availableTokens < profile.budget.tokens) return false;
    const date = new Date(run.admittedAt).toISOString();
    this.reservations.set(run.id, { run: { ...run }, tenantWindow: date.slice(0,10), fleetWindow: date.slice(0,7), tokensReserved: profile.budget.tokens, costReserved: profile.budget.costUnits, active: true, counters: emptyCounters(), attempts: new Set() });
    return true;
  }
  begin(id: string, attemptId: string): boolean {
    const r = this.reservations.get(id);
    if (!r || !r.active || r.attempts.has(attemptId) || r.counters.usageState === 'unknown' || r.counters.logicalSlots >= 4) return false;
    r.attempts.add(attemptId); r.counters.logicalSlots++; r.counters.usageState = 'unknown'; return true;
  }
  private settled = new Set<string>();
  observe(id: string, role: 'draft' | 'director', attemptId: string, observation: Observation | null): boolean {
    const r = this.reservations.get(id);
    if (!r || !r.active || !r.attempts.has(attemptId) || this.settled.has(attemptId) || !observation) return false;
    this.settled.add(attemptId);
    const { inputUnits: input, generatedUnits: output } = observation;
    if (!Number.isSafeInteger(input) || !Number.isSafeInteger(output) || input < 0 || output < 0) { r.counters.usageState = 'unknown'; return false; }
    if (!Number.isSafeInteger(r.counters.projectedTokens + input + output)) { r.counters.usageState = 'unknown'; return false; }
    r.counters.projectedTokens += input + output;
    r.counters.usageState = 'known';
    const inputMax = role === 'draft' ? 4096 : 8192;
    const outputMax = role === 'draft' ? 768 : 1024;
    return input <= inputMax && output <= outputMax && r.counters.projectedTokens <= 28160;
  }
  complete(id: string): void {
    const r = this.reservations.get(id);
    if (r && r.counters.usageState === 'known') { r.active = false; r.tokensReserved = 0; r.costReserved = 0; }
  }
  counters(id: string): Counters { return { ...(this.reservations.get(id)?.counters ?? emptyCounters()) }; }
  snapshot(id: string) { const r = this.reservations.get(id); return r ? { ...r, run: { ...r.run }, counters: { ...r.counters }, attempts: [...r.attempts] } : null; }
}
export function expired(run: Run, utc: number, mono: number): boolean { return utc >= run.deadlineAt || mono - run.monoAt >= 120000 || mono < run.monoAt; }
