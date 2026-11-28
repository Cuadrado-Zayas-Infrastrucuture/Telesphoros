import { z } from 'zod';
import type { GlossaryEntry, HelpAnswer, HelpArticle } from '@telesphoros/help-content';

/**
 * Spec 003's help lane ([help-lane.md](../../../../specs/003-llm-harness/help-lane.md)), spec 053 slice C2b: what goes into and out of a model
 * answer for Help. A model answers only from signed articles the curated engine already chose, and every failure shows the curated answer.
 */
export const HELP_TASK = 'help.answer.v1';

/** The lane's limits (FR-H10): one attempt, no repair, a deadline, an output cap, at most three articles. Part of the harness version. */
export const HELP_LIMITS = { attempts: 1, repairs: 0, deadlineMs: 15000, maxOutputUnits: 600, maxArticles: 3, maxSentences: 6, maxQuestionChars: 500 } as const;

/** The label every released model answer carries (FR-H6, R4). Spec 053 section 3 as amended by HL-D1: the model answers only from signed articles. */
export const HELP_LABEL = 'Written by an assistant from the articles below.';

/** What the model must reply (FR-H2): plain sentences, each citing one article and the exact passage it rests on, and one out-of-scope flag. */
export const helpReplySchema = z.strictObject({
  outOfScope: z.boolean(),
  sentences: z
    .array(
      z.strictObject({
        text: z.string().min(1).max(400),
        articleId: z.string().regex(/^[a-z0-9-]{1,64}$/),
        passage: z.string().min(1).max(1000),
      }),
    )
    .max(HELP_LIMITS.maxSentences),
});
export type HelpReply = z.infer<typeof helpReplySchema>;

/** Every way a question ends without a released model answer. Each shows the curated answer, never an error (R4). */
export const HELP_REASONS = [
  'REFUSED_BY_RULE',
  'NO_GOOD_MATCH',
  'NO_SIGNED_ARTICLE',
  'INPUT_REFUSED',
  'MODEL_ERROR',
  'DEADLINE',
  'USAGE_HELD',
  'INVALID_STRUCTURE',
  'OUT_OF_SCOPE',
  'CHECK_HOLD',
] as const;
export type HelpReason = (typeof HELP_REASONS)[number];

/** The two signers the evaluation's fixture corpus is signed by (C2-D1). Outside the evaluation, an item they signed counts as unsigned. */
export const TEST_SIGNERS: readonly string[] = ['TEST SIGNER A', 'TEST SIGNER B'];
type Signed = Pick<HelpArticle, 'status' | 'signedBy'> | Pick<GlossaryEntry, 'status' | 'signedBy'>;
/** Signed by two pharmacists, and, unless the evaluation runner asks for its fixtures, by no test signer (HC-D4, C2-D1). */
export function signedForModel(item: Signed, allowTestSigners = false): boolean {
  if (item.status !== 'signed' || item.signedBy.length < 2) return false;
  return allowTestSigners || item.signedBy.every((signer) => !TEST_SIGNERS.includes(signer.name));
}

/** A link a released answer shows, taken from a cited article's own links by code, never written by the model. */
export interface HelpLink {
  screen: string;
  label: string;
}
/** What a question ends as: a released model answer, or exactly the curated answer, with the reason the model's was not used. */
export type HelpLaneOutcome =
  | { kind: 'model'; label: typeof HELP_LABEL; sentences: readonly string[]; cited: readonly string[]; links: readonly HelpLink[] }
  | { kind: 'curated'; answer: HelpAnswer; reason: HelpReason };

/** What is kept of a question (FR-H9): no question, no answer, no digest of either. Ids, check results, codes, counters and identity only. */
export interface HelpReceipt {
  task: typeof HELP_TASK;
  templateDigest: string | null;
  modelId: string | null;
  outcome: 'model' | 'curated';
  reason: HelpReason | null;
  holds: readonly string[];
  citedIds: readonly string[];
  sentIds: readonly string[];
  modelCalls: number;
  inputUnits: number;
  generatedUnits: number;
}
