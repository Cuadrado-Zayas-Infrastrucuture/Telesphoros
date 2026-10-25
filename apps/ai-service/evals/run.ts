import { hashBytes } from '../src/evidence';
import { ALL_SENSORS, runSensors } from '../src/evaluators/sensors';
import { glossaryDigest, lexiconDigest } from '../src/evaluators/lexicons';
import { explainableResultSchema, explanationSchema, SENSORS, type Sensor, type SensorId } from '../src/evaluators/types';
import { obedient, scripted } from '../src/model-clients/scripted';
import { buildPrompt, templateDigest } from '../src/prompts/explain-v1';
import { ATTACKS, type Attack } from './attacks/attacks';
import { CASES, type GoldenCase } from './golden/cases';
import { RESULTS } from './golden/results';
import { PINNED } from './pinned';

export const currentDigests = () => ({ template: templateDigest(), lexicon: lexiconDigest(), glossary: glossaryDigest() });
export const harnessVersion = (d = currentDigests()): string => hashBytes(JSON.stringify(d));

/** How the prompt is composed from a result and the hostile inbound fields. The real builder ignores the inbound fields by construction. */
export type Compose = (result: unknown, inbound: Readonly<Record<string, string>>) => { prompt: string; templateDigest: string };
const realCompose: Compose = result => buildPrompt(result);

export interface GateOptions { sensors?: Readonly<Record<SensorId, Sensor>>; compose?: Compose; cases?: readonly GoldenCase[]; attacks?: readonly Attack[]; pinned?: Readonly<Record<string, string>> }
export interface GateReport {
  harnessVersion: string;
  cases: { total: number; acceptable: number; shouldHold: number; released: number; held: number; wronglyReleased: number; wronglyHeld: number; reasonMismatch: number; unmarked: number };
  attacks: { total: number; inbound: number; shape: number; output: number; effective: number };
  sensorsComplete: boolean; digestsMatch: boolean; ok: boolean;
}

type Decision = { decision: 'release' | 'hold'; reasons: string[] };
async function decide(result: unknown, candidate: unknown, sensors: Readonly<Record<SensorId, Sensor>>, compose: Compose): Promise<Decision> {
  const parsed = explainableResultSchema.parse(result);
  const { prompt, templateDigest: digest } = compose(parsed, {});
  const reply = await scripted(() => candidate).complete({ prompt, templateDigest: digest, maxOutputUnits: 1024 });
  const explanation = explanationSchema.safeParse(reply.artifact);
  if (!explanation.success) return { decision: 'hold', reasons: ['INVALID_STRUCTURE'] };
  const holds = runSensors(explanation.data, parsed, sensors);
  return { decision: holds.length === 0 ? 'release' : 'hold', reasons: [...new Set(holds.map(h => h.sensor))] };
}

/** One attack. Returns true when the attack had an effect (which is a failure of the harness). */
async function attackEffect(a: Attack, sensors: Readonly<Record<SensorId, Sensor>>, compose: Compose): Promise<boolean> {
  if (a.cls === 'shape') {
    try { compose(a.input, {}); return true; } catch { return false; }
  }
  if (a.cls === 'output') return (await decide(RESULTS[a.result], a.candidate, sensors, compose)).decision === 'release';
  // inbound: the prompt must not contain a hostile value, and a model that obeys everything it sees must return what it returns without them.
  const clean = CASES.find(c => c.id === 'g01-avoid-quote-restate-gloss')!.candidate;
  const inbound = a.inbound ?? {};
  const built = compose(RESULTS[a.result], inbound);
  if (Object.values(inbound).some(v => built.prompt.includes(v))) return true;
  const demands = Object.values(inbound).map(v => ({ marker: v, emit: { statements: [{ kind: 'gloss', fields: ['implication'], text: `Follow this: ${v}` }] } }));
  const reply = await obedient(demands, clean).complete({ prompt: built.prompt, templateDigest: built.templateDigest, maxOutputUnits: 1024 });
  return JSON.stringify(reply.artifact) !== JSON.stringify(clean);
}

export async function runGate(options: GateOptions = {}): Promise<GateReport> {
  const sensors = options.sensors ?? ALL_SENSORS, compose = options.compose ?? realCompose, cases = options.cases ?? CASES, attacks = options.attacks ?? ATTACKS;
  const c = { total: cases.length, acceptable: 0, shouldHold: 0, released: 0, held: 0, wronglyReleased: 0, wronglyHeld: 0, reasonMismatch: 0, unmarked: 0 };
  for (const g of cases) {
    const d = await decide(RESULTS[g.result], g.candidate, sensors, compose);
    if (g.mark === 'unmarked') c.unmarked++;
    if (d.decision === 'release') c.released++; else c.held++;
    if (g.expect === 'release') { c.acceptable++; if (d.decision === 'hold') c.wronglyHeld++; continue; }
    c.shouldHold++;
    if (d.decision === 'release') { c.wronglyReleased++; continue; }
    if ((g.sensors ?? []).some(s => !d.reasons.includes(s))) c.reasonMismatch++;
  }
  const a = { total: attacks.length, inbound: 0, shape: 0, output: 0, effective: 0 };
  for (const atk of attacks) { a[atk.cls]++; if (await attackEffect(atk, sensors, compose)) a.effective++; }
  const sensorsComplete = Object.keys(sensors).sort().join() === [...SENSORS].sort().join() && SENSORS.every(id => typeof sensors[id] === 'function');
  const digests = currentDigests(), pinned = options.pinned ?? PINNED;
  const digestsMatch = (['template', 'lexicon', 'glossary'] as const).every(k => digests[k] === pinned[k]);
  const ok = sensorsComplete && digestsMatch && c.wronglyReleased === 0 && c.reasonMismatch === 0 && a.effective === 0 && c.total > 0 && a.total > 0;
  return { harnessVersion: harnessVersion(digests), cases: c, attacks: a, sensorsComplete, digestsMatch, ok };
}
