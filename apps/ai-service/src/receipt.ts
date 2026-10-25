import { canonicalJson, keyedDigest } from './keyed-digest';
import type { ModelIdentity } from './model-clients/port';
import { outcomeV2Schema, OUTCOME_V2, type OutcomeV2 } from './outcome-v2';
import { EXPLAIN_TASK } from './explain-contracts';

export interface ReceiptFacts {
  context: { tenantId: string; requesterRef: string };
  runId: string | null;
  released: boolean;
  reasonCode: string;
  detail: string | null;
  harnessVersion: string;
  model: ModelIdentity | null;
  templateDigest: string | null;
  /** What the run was asked about. Only its keyed digest is kept. */
  evidence: unknown;
  /** The last model output the run saw, if any. Only its keyed digest is kept. */
  artifact: { present: boolean; value?: unknown };
  guardsRun: readonly string[];
  counters: { slots: number; modelCalls: number; inputUnits: number; generatedUnits: number; usageState: 'known' | 'unknown' };
  key: Uint8Array;
}

const canonicalOrMarker = (value: unknown): string => {
  try {
    return canonicalJson(value);
  } catch {
    return '"unserializable"';
  }
};
/** Fixed codes out of a detail string such as "S3_X,S6_Y" or "task: R4_NO_CHECKS;task: R1_X". Anything that is not code-shaped is dropped. */
const detailCodes = (detail: string | null): string[] =>
  (detail ?? '')
    .split(/[,;]/)
    .map((part) => {
      const at = part.lastIndexOf(': ');
      return (at < 0 ? part : part.slice(at + 2)).trim();
    })
    .filter((part) => /^[A-Za-z][A-Za-z0-9_-]{1,63}$/.test(part))
    .slice(0, 16);

/**
 * The durable record of a run: digests, fixed codes and counters, never text (FR-009, FR-014). Returns null when the facts do not make a valid record
 * (for instance a key shorter than 32 bytes); the run itself still returns the engine text.
 */
export function buildReceipt(f: ReceiptFacts): OutcomeV2 | null {
  try {
    const parsed = outcomeV2Schema.safeParse({
      schemaVersion: OUTCOME_V2,
      evidenceKind: 'harness-run',
      runId: f.runId ?? 'unadmitted',
      tenantId: f.context.tenantId,
      requesterRef: f.context.requesterRef,
      task: EXPLAIN_TASK,
      terminalState: f.released ? 'released' : f.reasonCode === 'DEADLINE' ? 'expired' : 'held',
      reasonCode: f.reasonCode,
      detailCodes: detailCodes(f.detail),
      harnessVersion: f.harnessVersion,
      model: f.counters.modelCalls > 0 ? f.model : null,
      digests: {
        template: f.templateDigest,
        evidence: keyedDigest(f.key, canonicalOrMarker(f.evidence)),
        output: f.artifact.present ? keyedDigest(f.key, canonicalOrMarker(f.artifact.value)) : null,
      },
      guardsRun: f.guardsRun,
      counters: f.counters,
    });
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
