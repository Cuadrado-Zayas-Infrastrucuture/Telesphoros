import {
  answerFor,
  GLOSSARY_EN,
  HELP_EN,
  helpScreenOf,
  normalizeHelpText,
  withoutTrailingSlashes,
  type GlossaryEntry,
  type HelpAnswer,
  type HelpArticle,
  type HelpCorpus,
} from '@telesphoros/help-content';
import type { ModelPort } from '../model-clients/port';
import { HELP_LABEL, HELP_LIMITS, HELP_TASK, helpReplySchema, signedForModel, type HelpLaneOutcome, type HelpReason, type HelpReceipt } from './contracts';
import { isOutOfScope, runHelpChecks } from './checks';
import { meaningWords } from './lexicons';
import { buildHelpPrompt, HelpInputRefused } from './prompt-v1';

/** What the caller passes: the question, the address in view and the person's roles. Nothing else about the person, and no patient data. */
export interface HelpQuestion {
  question: string;
  pathname: string;
  roles: readonly string[];
}
export interface HelpLaneOptions {
  /** The corpus to answer from: the signed product articles by default. The evaluation runner passes its fixture corpus. */
  corpus?: HelpCorpus;
  /** Only the evaluation runner sets this, for its test-signed fixtures (C2-D1). */
  allowTestSigners?: boolean;
  /** The deadline for the one call; HELP_LIMITS.deadlineMs by default. */
  deadlineMs?: number;
}

const PRODUCT_CORPUS: HelpCorpus = { articles: HELP_EN.articles, glossary: GLOSSARY_EN };
const unique = <T>(items: readonly T[]): T[] => [...new Set(items)];

/** The glossary entries a set of articles names, by whole alias, as the screens find them. Only signed ones go to a model. */
function glossaryNamedBy(articles: readonly HelpArticle[], glossary: readonly GlossaryEntry[], allowTestSigners: boolean): GlossaryEntry[] {
  const words = articles
    .flatMap((a) => [a.title, ...a.body])
    .map(normalizeHelpText)
    .join(' ');
  const text = ` ${words} `;
  return glossary.filter((entry) => signedForModel(entry, allowTestSigners) && entry.aliases.some((alias) => text.includes(` ${normalizeHelpText(alias)} `)));
}

function deadline(ms: number): { promise: Promise<'DEADLINE'>; clear: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<'DEADLINE'>((resolve) => {
    timer = setTimeout(() => resolve('DEADLINE'), ms);
  });
  return { promise, clear: () => clearTimeout(timer) };
}

/**
 * Spec 003's help lane (help-lane.md section 2): answers one question, with a model if it may, or with exactly the curated answer if not.
 * 1. The curated engine runs first (`answerFor`). A refusal, a closest-three answer, or a match with no signed article returns it, and the
 *    model is never called.
 * 2. Otherwise one call, with no repair. Any failure (a refused input, a port error, the deadline, unknown usage, a reply that breaks the
 *    contract, the model's own out-of-scope flag, or any check on any sentence) returns the curated answer, or the refusal when the model
 *    said out of scope. Its reason is in the receipt, never on screen.
 * Nothing typed or answered is kept: the receipt holds ids, codes, counters and identity only (FR-H9). Nothing in the product calls this
 * until slice C3, and then only behind a switch that is off.
 */
export async function runHelpAnswer(input: HelpQuestion, port: ModelPort, options: HelpLaneOptions = {}): Promise<{ outcome: HelpLaneOutcome; receipt: HelpReceipt }> {
  const corpus = options.corpus ?? PRODUCT_CORPUS;
  const allowTestSigners = options.allowTestSigners === true;
  const curated = answerFor(input.question, corpus, input.pathname, input.roles);
  const receipt: HelpReceipt = {
    task: HELP_TASK,
    templateDigest: null,
    modelId: null,
    outcome: 'curated',
    reason: null,
    holds: [],
    citedIds: [],
    sentIds: [],
    modelCalls: 0,
    inputUnits: 0,
    generatedUnits: 0,
  };
  const fallback = (reason: HelpReason, answer: HelpAnswer = curated, holds: readonly string[] = []) => ({
    outcome: { kind: 'curated' as const, answer, reason },
    receipt: { ...receipt, reason, holds },
  });

  if (curated.kind === 'refusal') return fallback('REFUSED_BY_RULE');
  if (curated.kind === 'closest') return fallback('NO_GOOD_MATCH');
  const sent = unique([curated.hit, ...curated.more].flatMap((hit) => (hit.kind === 'article' ? [hit.article] : [])))
    .filter((article) => signedForModel(article, allowTestSigners))
    .slice(0, HELP_LIMITS.maxArticles);
  if (sent.length === 0) return fallback('NO_SIGNED_ARTICLE');
  receipt.sentIds = sent.map((a) => a.id);

  let built: ReturnType<typeof buildHelpPrompt>;
  try {
    built = buildHelpPrompt({
      question: input.question,
      screen: helpScreenOf(input.pathname),
      roles: input.roles,
      articles: sent,
      glossary: glossaryNamedBy(sent, corpus.glossary, allowTestSigners),
    });
  } catch (error) {
    if (error instanceof HelpInputRefused) return fallback('INPUT_REFUSED');
    throw error;
  }
  receipt.templateDigest = built.templateDigest;
  receipt.modelId = port.identity.modelId;

  const timer = deadline(options.deadlineMs ?? HELP_LIMITS.deadlineMs);
  let reply: Awaited<ReturnType<ModelPort['complete']>> | 'DEADLINE';
  try {
    receipt.modelCalls = 1;
    reply = await Promise.race([port.complete({ prompt: built.prompt, templateDigest: built.templateDigest, maxOutputUnits: HELP_LIMITS.maxOutputUnits }), timer.promise]);
  } catch {
    return fallback('MODEL_ERROR');
  } finally {
    timer.clear();
  }
  if (reply === 'DEADLINE') return fallback('DEADLINE');
  if (reply.observation === null) return fallback('USAGE_HELD');
  receipt.inputUnits = reply.observation.inputUnits;
  receipt.generatedUnits = reply.observation.generatedUnits;

  const parsed = helpReplySchema.safeParse(reply.artifact);
  if (!parsed.success) return fallback('INVALID_STRUCTURE');
  // The model's own refusal check can only add a refusal (HL-D3): the answer becomes the refusal, as the rule's would be.
  if (isOutOfScope(parsed.data)) {
    const onPatientPage = helpScreenOf(input.pathname) === 'patient';
    return fallback('OUT_OF_SCOPE', { kind: 'refusal', patientLink: onPatientPage ? `${withoutTrailingSlashes(input.pathname)}#patient-results` : null });
  }
  const holds = runHelpChecks(parsed.data, { sent, roles: input.roles, meaning: meaningWords(corpus.articles, corpus.glossary), allowTestSigners });
  if (holds.length > 0) return fallback('CHECK_HOLD', curated, holds);

  const cited = unique(parsed.data.sentences.map((s) => s.articleId));
  const links = sent.filter((a) => cited.includes(a.id)).flatMap((a) => a.links.map((link) => ({ screen: link.screen, label: link.label })));
  return {
    outcome: { kind: 'model', label: HELP_LABEL, sentences: parsed.data.sentences.map((s) => s.text), cited, links },
    receipt: { ...receipt, outcome: 'model', citedIds: cited },
  };
}
