// Spec 053 slice C2a: Help's answer to one question, refusal first, lives in packages/help-content (src/engine/answer.ts), so C2's model
// path falls back to the same function. This file keeps the frontend's imports unchanged.
export { answerFor, answerForHit, hitKey, MORE_HITS, type HelpAnswer, type HelpCorpus } from '@telesphoros/help-content';
