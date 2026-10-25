import crypto from 'node:crypto';
import { REASONS_FOR_KIND, type EvaluationDto } from '@telesphoros/shared-types';
import { fail } from './client.js';

/** Validate the API's ordered history, not a new clinical state machine or write policy. */
export function correctionHistory(evaluation: EvaluationDto) {
  let previous: string | null = null;
  let state: EvaluationDto['state'] = 'active';
  let replacement: string | null = null;
  const seen = new Set<string>();
  if (evaluation.corrections.length > 500) fail('invalid_correction_history');
  const events = evaluation.corrections.map((c) => {
    if (
      c.evaluationId !== evaluation.id ||
      seen.has(c.id) ||
      c.previousCorrectionId !== previous ||
      !REASONS_FOR_KIND[c.kind].includes(c.reasonCode) ||
      state === 'superseded' ||
      (c.kind === 'reinstatement' ? state !== 'retracted' : state !== 'active') ||
      (c.kind === 'supersession' ? !c.replacementEvaluationId || c.replacementEvaluationId === evaluation.id : c.replacementEvaluationId !== null)
    )
      fail('invalid_correction_history');
    seen.add(c.id);
    previous = c.id;
    state = c.kind === 'retraction' ? 'retracted' : c.kind === 'supersession' ? 'superseded' : 'active';
    replacement = c.replacementEvaluationId;
    return { id: c.id, kind: c.kind, reasonCode: c.reasonCode, createdAt: c.createdAt };
  });
  if (evaluation.state !== state || evaluation.supersededBy !== replacement || (state !== 'active' && evaluation.current)) fail('invalid_correction_history');
  const history = { evaluationId: evaluation.id, state: evaluation.state, current: evaluation.current, events };
  return { ...history, revision: crypto.createHash('sha256').update(JSON.stringify(history)).digest('hex') };
}
export type CorrectionHistory = ReturnType<typeof correctionHistory>;
