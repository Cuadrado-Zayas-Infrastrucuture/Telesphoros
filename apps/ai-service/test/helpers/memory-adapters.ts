import { canTransition, terminal } from '../../src/kernel';
import { SyntheticBudgets } from '../../src/budgets';
import type { Authority, Context, Outcome, Ports, Run, State } from '../../src/contracts';
import { fixture } from '../fixtures/synthetic-sop';

export class MemoryStore {
  runs = new Map<string, Run>(); outcomes = new Map<string, Outcome>();
  keys = new Map<string, { tuple: string; id: string }>();
  events: Array<{ runId: string; kind: string; sequence: number }> = [];
  auditAvailable = true; beforeCommit = () => {}; next = 0;
  admit(key: string, tuple: string, context: Context, profileDigest: string, utc: number, mono: number) {
    const prior = this.keys.get(key);
    if (prior) return { kind: prior.tuple === tuple ? 'existing' as const : 'conflict' as const, run: this.get(prior.id) };
    const run: Run = { id: `${context.tenantId}-${++this.next}`, tenantId: context.tenantId, requesterRef: context.requesterRef, profileDigest, state: 'admitted', sequence: 0, fence: 1, admittedAt: utc, monoAt: mono, deadlineAt: utc + 120000 };
    this.runs.set(run.id,run); this.keys.set(key,{ tuple,id:run.id }); return { kind: 'new' as const, run: { ...run } };
  }
  get(id: string): Run { const r = this.runs.get(id); if (!r) throw new Error('NO_RUN'); return { ...r }; }
  matches(expected: Run): boolean {
    const r = this.get(expected.id);
    return r.tenantId === expected.tenantId && r.requesterRef === expected.requesterRef && r.profileDigest === expected.profileDigest && r.state === expected.state && r.sequence === expected.sequence && r.fence === expected.fence && !terminal(r.state);
  }
  advance(expected: Run, state: State): Run | null {
    if (!this.matches(expected) || !canTransition(expected.state,state)) return null;
    const r = { ...expected,state,sequence:expected.sequence+1 }; this.runs.set(r.id,r); return { ...r };
  }
  outcome(id: string): Outcome | null { return structuredClone(this.outcomes.get(id) ?? null); }
  commitSimulation(expected: Run, result: Outcome, guard: () => boolean, settle: () => void): boolean {
    this.beforeCommit();
    if (!this.matches(expected) || !canTransition(expected.state,result.terminalState) || !this.auditAvailable || !guard()) return false;
    settle();
    this.runs.set(expected.id,{ ...expected,state:result.terminalState,sequence:expected.sequence+1 });
    this.outcomes.set(expected.id,structuredClone(result)); this.events.push({ runId:expected.id,kind:result.reasonCode,sequence:expected.sequence+1 }); return true;
  }
  cancel(id: string) { const r = this.get(id); if (!terminal(r.state)) this.runs.set(id,{ ...r,state:'cancelled',fence:r.fence+1,sequence:r.sequence+1 }); }
}
export function scenario(locale: 'en' | 'es' = 'en', tenant = 'tenant-a') {
  const data = fixture(locale,tenant); const store = new MemoryStore(); const budgets = new SyntheticBudgets();
  const counts = { reads: 0, drafts: 0, directors: 0 }; const trace: string[] = [];
  const hooks: Record<string, () => void> = {};
  let utc = Date.UTC(2026,9,31,23,59,0); let mono = 0;
  const authority: Authority = { tenantId:tenant,requesterRef:'staff-a',generation:1,member:true,session:true,expiresAt:utc+3600000,purpose:'business-assistance',capabilities:['business.sop.read','business.sop.draft'],sourceIds:[data.source.id] };
  const ports: Ports = {
    authority: { current: () => structuredClone(authority) },
    sources: { resolve: () => { counts.reads++; return [structuredClone(data.source)]; } },
    actors: {
      draft: async () => { counts.drafts++; return { artifact: structuredClone(data.candidate), observation:{ inputUnits:100,generatedUnits:50 } }; },
      director: async (candidate,evidenceDigest) => { counts.directors++; return { artifact:{ decision:'accept',candidateDigest:candidate.digest,evidenceDigest,claimVerdicts:[{ claimId:'claim-1',supported:true }] },observation:{ inputUnits:100,generatedUnits:50 } }; },
    }, store,budgets,
    clock: { utcNowMs: () => utc,monotonicNowMs: () => mono },
    boundary: name => { trace.push(name); hooks[name]?.(); },
  };
  return { ...data,ports,store,budgets,counts,trace,hooks,authority,
    tick: (ms:number) => { utc += ms; mono += ms; },
    revoke: () => { authority.generation++; authority.capabilities=[]; },
  };
}
export function runVector(id = 'r1', tenant = 'tenant-a', utc = Date.UTC(2026,9,31,23,59,0)): Run {
  return { id,tenantId:tenant,requesterRef:'staff-a',state:'admitted',sequence:0,fence:1,admittedAt:utc,monoAt:0,deadlineAt:utc+120000,profileDigest:'sha256:'+'a'.repeat(64) };
}
