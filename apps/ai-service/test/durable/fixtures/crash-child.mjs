// Dedicated crash child for the owned PostgreSQL suite. It acts as a synthetic worker through the
// same SQL entry points the adapter uses, prints a stage marker, then blocks until the parent
// SIGKILLs it. Synthetic fixture data only; it reads no environment besides its two inputs.
import { createHash, randomUUID } from 'node:crypto';
import pg from 'pg';

const [mode] = process.argv.slice(2);
const workerUrl = process.env.P2_CHILD_WORKER_URL;
if (!workerUrl || !['before-begin', 'after-begin', 'after-finish'].includes(mode)) process.exit(2);
const sha = value => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const client = new pg.Client({ connectionString: workerUrl });
await client.connect();
const call = async (fn, ...args) => {
  const placeholders = args.map((a, i) => `$${i + 1}${typeof a === 'string' && fn === 'advance' && i === 2 ? '::text' : '::jsonb'}`);
  const { rows } = await client.query(`SELECT public.agentic_synthetic_${fn}(${placeholders.join(',')}) AS r`,
    args.map((a, i) => (fn === 'advance' && i === 2 ? a : JSON.stringify(a))));
  if (rows[0].r.kind !== 'ok') { process.stdout.write(`REFUSED ${fn} ${rows[0].r.code}\n`); process.exit(3); }
  return rows[0].r.value;
};
const { rows: claimed } = await client.query('SELECT * FROM public.agentic_synthetic_claim($1,1)', ['crash-child']);
if (claimed.length !== 1) process.exit(4);
const c = claimed[0];
const stamp = { jobId: c.id, runId: c.run_id, workerId: 'crash-child', queueAttempt: c.attempt, claimId: c.claim_id, fence: String(c.fence) };
let view = await call('load', stamp, { state: c.state, sequence: String(c.sequence) });
const expected = () => ({ state: view.state, sequence: view.sequence });
const sources = await call('sources', stamp, expected());
const tuple = sources.map(s => [s.id, s.version, s.digest]);
const evidence = sha(JSON.stringify(tuple));
view = await call('advance', stamp, expected(), 'running');
const block = stage => { process.stdout.write(`${stage}\n`); setInterval(() => undefined, 60_000); };
if (mode === 'before-begin') block('READY');
else {
  const d1 = { invocationId: randomUUID(), role: 'draft', ordinal: 1,
    inputDigest: sha(JSON.stringify([`${stamp.runId}:draft:1`, evidence, tuple])) };
  view = await call('begin', stamp, expected(), d1);
  if (mode === 'after-begin') block('READY');
  else {
    const body = Buffer.from(sources[0].body, 'utf8');
    const text = body.subarray(0, 26).toString('utf8');
    const candidate = { text, digest: sha(text), claims: [{ id: 'claim-1', text, sourceId: sources[0].id, startByte: 0, endByte: 26 }] };
    const receipt = inv => ({ invocationId: inv.invocationId, role: inv.role, inputDigest: inv.inputDigest });
    view = await call('observe', stamp, expected(), { ...receipt(d1), observation: { inputUnits: 120, generatedUnits: 40 }, artifact: candidate });
    view = await call('advance', stamp, expected(), 'reviewing');
    const v1 = { invocationId: randomUUID(), role: 'director', ordinal: 1,
      inputDigest: sha(JSON.stringify([`${stamp.runId}:director:1`, candidate.digest, evidence])) };
    view = await call('begin', stamp, expected(), v1);
    const verdict = { decision: 'accept', candidateDigest: candidate.digest, evidenceDigest: evidence,
      claimVerdicts: [{ claimId: 'claim-1', supported: true }] };
    view = await call('observe', stamp, expected(), { ...receipt(v1), observation: { inputUnits: 300, generatedUnits: 60 }, artifact: verdict });
    view = await call('advance', stamp, expected(), 'release-pending');
    await call('finish', stamp, expected(), { terminalState: 'released', reasonCode: 'SIMULATED_RELEASE', candidate, verdict, evidenceDigest: evidence });
    block('READY'); // committed outcome; queue acknowledgement never sent
  }
}
