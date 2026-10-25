import { z } from 'zod';
import type { Explanation } from './types';

/** The verifier's reply. It judges each statement; it has no way to say anything but accept or hold. */
export const verifierReplySchema = z.strictObject({
  decision: z.enum(['accept', 'hold']),
  statements: z.array(z.strictObject({ index: z.number().int().nonnegative(), supported: z.boolean() })).max(8),
});

/**
 * The verifier can only add a hold (FR-005). Accepted only when the reply is well formed, says accept, and covers every
 * statement exactly once with `supported: true`. Anything else, including a malformed reply, is a hold.
 */
export function checkVerifierReply(artifact: unknown, explanation: Explanation): { ok: true } | { ok: false; reason: string } {
  const parsed = verifierReplySchema.safeParse(artifact);
  if (!parsed.success) return { ok: false, reason: 'VERIFIER_INVALID' };
  const { decision, statements } = parsed.data;
  const seen = new Set(statements.map((s) => s.index));
  if (seen.size !== statements.length || statements.length !== explanation.statements.length || explanation.statements.some((_, i) => !seen.has(i)))
    return { ok: false, reason: 'VERIFIER_COVERAGE' };
  if (decision !== 'accept' || statements.some((s) => !s.supported)) return { ok: false, reason: 'VERIFIER_HELD' };
  return { ok: true };
}
