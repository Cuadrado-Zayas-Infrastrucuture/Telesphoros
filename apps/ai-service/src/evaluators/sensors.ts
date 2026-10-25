import { checkCandidate, hashBytes } from '../evidence';
import { ALWAYS_BANNED, familyOf, FRAME, GLOSSARY, QUALIFIERS, RESTATE_FRAME } from './lexicons';
import { NUMBER_WORDS, numerals, words } from './text';
import { SENSORS, type Explanation, type ExplainableResult, type Hold, type Sensor, type SensorId } from './types';

const resultStrings = (r: ExplainableResult): string[] => [r.drug, r.strength, ...r.genes.flatMap((g) => [g.gene, g.phenotype]), r.recommendationText, r.implication ?? ''];
const wordingStrings = (r: ExplainableResult): string[] => [r.recommendationText, r.implication ?? ''];
const nameWords = (r: ExplainableResult): Set<string> => new Set([r.drug, r.strength, ...r.genes.flatMap((g) => [g.gene, g.phenotype])].flatMap(words));
const allWords = (r: ExplainableResult): Set<string> => new Set(resultStrings(r).flatMap(words));
const own = (st: Explanation['statements'][number]) => (st.kind === 'quote' ? null : st);

/** The next token that is not a function word, or undefined at the end of the statement. */
function nextContent(tokens: string[], from: number): string | undefined {
  for (let i = from + 1; i < tokens.length; i++) if (!FRAME.has(tokens[i])) return tokens[i];
  return undefined;
}
const sentences = (text: string): string[] => text.split(/[.;:\n]+/).filter((x) => x.trim() !== '');
/** "family|next" for every direction, strength or negation word in a text, paired within each sentence as the result's wording pairs them. */
function pairs(text: string): Set<string> {
  const out = new Set<string>();
  for (const sentence of sentences(text)) {
    const tokens = words(sentence);
    tokens.forEach((t, i) => {
      const f = familyOf(t);
      if (f !== undefined) out.add(`${f}|${nextContent(tokens, i) ?? ''}`);
    });
  }
  return out;
}

/** S1: a quote is a byte-exact span of the result's own wording. Reuses the kernel's span check (`checkCandidate`). */
export const s1: Sensor = (e, r) => {
  const holds: Hold[] = [];
  e.statements.forEach((st, i) => {
    if (st.kind !== 'quote') return;
    const body = st.field === 'implication' ? r.implication : r.recommendationText;
    try {
      if (body === null) throw new Error('no such field');
      checkCandidate({ text: st.text, digest: hashBytes(st.text), claims: [{ id: 'q', text: st.text, sourceId: 'f', startByte: st.startByte, endByte: st.endByte }] }, [
        { id: 'f', tenantId: 't', version: 'v', digest: hashBytes(body), body },
      ]);
    } catch {
      holds.push({ sensor: 'S1', reason: 'S1_QUOTE_NOT_IN_RESULT', statement: i });
    }
  });
  return holds;
};

/** S2: a restatement names only the result's own gene, phenotype, drug and strength, plus frame words. */
export const s2: Sensor = (e, r) => {
  const ok = nameWords(r),
    holds: Hold[] = [];
  e.statements.forEach((st, i) => {
    const s = own(st);
    if (!s || s.kind !== 'restate') return;
    if (words(s.text).some((t) => !(ok.has(t) || FRAME.has(t) || RESTATE_FRAME.has(t)))) holds.push({ sensor: 'S2', reason: 'S2_NAME_NOT_IN_RESULT', statement: i });
  });
  return holds;
};

/** S3: every word of a gloss is in the result, in the reviewed glossary, or a frame word. */
export const s3: Sensor = (e, r) => {
  const ok = allWords(r),
    holds: Hold[] = [];
  e.statements.forEach((st, i) => {
    const s = own(st);
    if (!s || s.kind !== 'gloss') return;
    if (words(s.text).some((t) => !(ok.has(t) || FRAME.has(t) || GLOSSARY.has(t)))) holds.push({ sensor: 'S3', reason: 'S3_TERM_NOT_ALLOWED', statement: i });
  });
  return holds;
};

/** S4: every numeral, and every number word, in a restatement or gloss is in the result. */
export const s4: Sensor = (e, r) => {
  const strings = resultStrings(r),
    nums = new Set(strings.flatMap(numerals)),
    nw = new Set(strings.flatMap(words).filter((w) => NUMBER_WORDS.has(w))),
    holds: Hold[] = [];
  e.statements.forEach((st, i) => {
    const s = own(st);
    if (!s) return;
    if (numerals(s.text).some((n) => !nums.has(n)) || words(s.text).some((w) => NUMBER_WORDS.has(w) && !nw.has(w)))
      holds.push({ sensor: 'S4', reason: 'S4_NUMBER_NOT_IN_RESULT', statement: i });
  });
  return holds;
};

/**
 * S5: direction, strength and negation words. A statement may use one only if the result's wording uses a word of that
 * family (the result's own strength word is exempt), and only paired with the same next term the result pairs it with.
 * "Consider drugv" is held when the result says "Avoid drugv. Consider an alternative".
 */
export const s5: Sensor = (e, r) => {
  const names = nameWords(r),
    have = pairs(wordingStrings(r).join('\n')),
    families = new Set([...have].map((p) => p.split('|')[0])),
    holds: Hold[] = [];
  e.statements.forEach((st, i) => {
    const s = own(st);
    if (!s) return;
    let reason: string | null = null;
    for (const sentence of sentences(s.text)) {
      const tokens = words(sentence);
      for (let k = 0; k < tokens.length && reason === null; k++) {
        const f = familyOf(tokens[k]);
        if (f === undefined || names.has(tokens[k])) continue;
        if (!families.has(f)) reason = 'S5_DIRECTION_NOT_IN_RESULT';
        else {
          const next = nextContent(tokens, k);
          if (next !== undefined && !have.has(`${f}|${next}`)) reason = 'S5_DIRECTION_PAIRING_CHANGED';
        }
      }
    }
    if (reason !== null) holds.push({ sensor: 'S5', reason, statement: i });
  });
  return holds;
};

const MARKUP = /[<>`{}[\]|\\]|:\/\/|www\./i;
const LIMITS = { statementChars: 400, totalChars: 1600 };
/** S6: format and length limits, banned words, and nothing dropped (every qualifier in the result's wording is carried). */
export const s6: Sensor = (e, r) => {
  const holds: Hold[] = [];
  let total = 0;
  e.statements.forEach((st, i) => {
    total += st.text.length;
    if (st.kind === 'quote') return;
    const t = st.text;
    if (t.length > LIMITS.statementChars) holds.push({ sensor: 'S6', reason: 'S6_STATEMENT_TOO_LONG', statement: i });
    if (/[^\x20-\x7e]/.test(t) || MARKUP.test(t) || /[?!]/.test(t)) holds.push({ sensor: 'S6', reason: 'S6_FORMAT', statement: i });
    if (words(t).some((w) => ALWAYS_BANNED.has(w))) holds.push({ sensor: 'S6', reason: 'S6_BANNED_WORD', statement: i });
  });
  if (total > LIMITS.totalChars) holds.push({ sensor: 'S6', reason: 'S6_TOTAL_TOO_LONG', statement: null });
  const carried = new Set(e.statements.flatMap((st) => words(st.text)));
  for (const q of new Set(wordingStrings(r).flatMap(words)))
    if (QUALIFIERS.has(q) && !carried.has(q)) {
      holds.push({ sensor: 'S6', reason: 'S6_QUALIFIER_DROPPED', statement: null });
      break;
    }
  return holds;
};

export const ALL_SENSORS: Readonly<Record<SensorId, Sensor>> = { S1: s1, S2: s2, S3: s3, S4: s4, S5: s5, S6: s6 };
/** Runs every sensor. A sensor that is missing is a hold, never a pass: the harness fails closed. */
export const runSensors = (e: Explanation, r: ExplainableResult, sensors: Readonly<Record<SensorId, Sensor>> = ALL_SENSORS): Hold[] =>
  SENSORS.flatMap(id => typeof sensors[id] === 'function' ? sensors[id](e, r) : [{ sensor: id, reason: 'SENSOR_MISSING', statement: null }]);

/** Every reason a sensor or the structure check can report. The repair prompt may list only these. */
export const KNOWN_HOLD_REASONS: ReadonlySet<string> = new Set(['INVALID_STRUCTURE', 'SENSOR_MISSING', 'S1_QUOTE_NOT_IN_RESULT', 'S2_NAME_NOT_IN_RESULT', 'S3_TERM_NOT_ALLOWED', 'S4_NUMBER_NOT_IN_RESULT',
  'S5_DIRECTION_NOT_IN_RESULT', 'S5_DIRECTION_PAIRING_CHANGED', 'S6_STATEMENT_TOO_LONG', 'S6_FORMAT', 'S6_BANNED_WORD', 'S6_TOTAL_TOO_LONG', 'S6_QUALIFIER_DROPPED']);
