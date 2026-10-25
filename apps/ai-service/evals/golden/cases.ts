import { RESULTS, type ResultKey } from './results';

export type WrongKind = 'invented-drug' | 'changed-strength' | 'flipped-direction' | 'added-number' | 'dropped-caveat' | 'wrong-gene' | 'advice-beyond-guideline' | 'altered-quote' | 'markup-or-link' | 'second-person' | 'bad-structure' | 'too-long' | 'directive-in-restate';
export interface GoldenCase {
  id: string; result: ResultKey; candidate: unknown; expect: 'release' | 'hold';
  kind: 'acceptable' | WrongKind;
  /** For a hold: every sensor listed must report (a different sensor catching it is a mismatch). `INVALID_STRUCTURE` is the structure check. */
  sensors?: readonly string[];
  /** The pharmacist's marking (D5). Every case is `unmarked` until the founder marks it; the machine expectation is the author's. */
  mark: 'unmarked' | 'accepted' | 'rejected';
}

const bytes = (s: string) => new TextEncoder().encode(s);
/** A quote of `needle` from the result's own field, with its byte span computed. Used for authoring only; sensors never call it. */
function quote(result: ResultKey, field: 'recommendationText' | 'implication', needle: string) {
  const body = RESULTS[result][field] as string, at = body.indexOf(needle);
  if (at < 0) throw new Error(`case authoring error: ${needle}`);
  const start = bytes(body.slice(0, at)).length;
  return { kind: 'quote', field, startByte: start, endByte: start + bytes(needle).length, text: needle };
}
const restate = (text: string, fields: string[] = ['drug', 'gene', 'phenotype', 'strength']) => ({ kind: 'restate', fields, text });
const gloss = (text: string, fields: string[] = ['implication']) => ({ kind: 'gloss', fields, text });
const ex = (...statements: unknown[]) => ({ statements });
const ok = (id: string, result: ResultKey, candidate: unknown): GoldenCase => ({ id, result, candidate, expect: 'release', kind: 'acceptable', mark: 'unmarked' });
const bad = (id: string, kind: WrongKind, result: ResultKey, candidate: unknown, ...sensors: string[]): GoldenCase => ({ id, result, candidate, expect: 'hold', kind, sensors, mark: 'unmarked' });

export const CASES: readonly GoldenCase[] = [
  ok('g01-avoid-quote-restate-gloss', 'avoid', ex(quote('avoid', 'recommendationText', 'Avoid drugv.'), restate('For drugv the guideline gives a Strong recommendation for patients with GENEA Synthetic Poor.'), gloss('Reduced enzyme function increases exposure to drugv in the body.'))),
  ok('g02-avoid-two-quotes', 'avoid', ex(quote('avoid', 'recommendationText', 'Avoid drugv.'), quote('avoid', 'recommendationText', 'Consider an alternative agent that does not depend on this pathway.'))),
  ok('g03-dose-quotes-and-restate', 'dose', ex(quote('dose', 'recommendationText', 'Start drugx at 50% of the standard dose and titrate to response.'), quote('dose', 'recommendationText', 'Monitor for adverse effects.'), restate('For drugx the guideline gives a Moderate recommendation for patients with GENEB Synthetic Intermediate.'))),
  ok('g04-dose-gloss-keeps-monitor', 'dose', ex(gloss('Reduced enzyme function lowers clearance of drugx in the body.'), quote('dose', 'recommendationText', 'Monitor for adverse effects.'))),
  ok('g05-optional-quote-and-restate', 'optional', ex(quote('optional', 'recommendationText', 'Consider a higher dose of drugy if the response is inadequate.'), restate('For drugy the guideline gives an Optional recommendation for patients with GENEC Synthetic Rapid.'))),
  ok('g06-normal-quote-restate', 'normal', ex(quote('normal', 'recommendationText', 'Use drugw at the standard dose.'), restate('For drugw the guideline gives a Strong recommendation for patients with GENEA Synthetic Normal.'))),
  ok('g07-two-quote-gloss', 'two', ex(quote('two', 'recommendationText', 'Avoid drugz in patients with this combination unless no alternative exists.'), gloss('Both genes affect clearance of drugz.'))),
  ok('g08-two-restate-both-genes', 'two', ex(restate('For drugz the guideline gives a Strong recommendation for patients with GENEA Synthetic Poor and GENEE Synthetic Normal.', ['drug', 'gene', 'phenotype', 'strength']), quote('two', 'recommendationText', 'Avoid drugz in patients with this combination unless no alternative exists.'))),

  bad('w01-invented-drug-restate', 'invented-drug', 'avoid', ex(restate('For drugq the guideline gives a Strong recommendation for patients with GENEA Synthetic Poor.')), 'S2'),
  bad('w02-invented-drug-gloss', 'invented-drug', 'avoid', ex(gloss('Reduced enzyme function increases exposure to drugq.')), 'S3'),
  bad('w03-changed-strength-restate', 'changed-strength', 'avoid', ex(restate('For drugv the guideline gives a Moderate recommendation for patients with GENEA Synthetic Poor.')), 'S2'),
  bad('w04-changed-strength-gloss', 'changed-strength', 'dose', ex(gloss('This is an optional change to the starting dose.')), 'S5'),
  bad('w05-flipped-consider-drug', 'flipped-direction', 'avoid', ex(gloss('Consider drugv.')), 'S5'),
  bad('w06-flipped-increased-function', 'flipped-direction', 'dose', ex(gloss('Increased enzyme function lowers clearance of drugx.')), 'S5'),
  bad('w07-flipped-lower-dose', 'flipped-direction', 'optional', ex(gloss('Consider a lower dose of drugy.')), 'S5'),
  bad('w08-flipped-negation', 'flipped-direction', 'normal', ex(gloss('Do not use drugw at the standard dose.')), 'S5'),
  bad('w09-added-number', 'added-number', 'dose', ex(gloss('Start drugx at 25% of the standard dose.')), 'S4'),
  bad('w10-added-number-word', 'added-number', 'optional', ex(gloss('Consider a double dose of drugy.')), 'S4'),
  bad('w11-dropped-caveat-if', 'dropped-caveat', 'optional', ex(quote('optional', 'recommendationText', 'Consider a higher dose of drugy')), 'S6'),
  bad('w12-dropped-caveat-unless', 'dropped-caveat', 'two', ex(quote('two', 'recommendationText', 'Avoid drugz in patients with this combination')), 'S6'),
  bad('w13-dropped-caveat-monitor', 'dropped-caveat', 'dose', ex(quote('dose', 'recommendationText', 'Start drugx at 50% of the standard dose and titrate to response.')), 'S6'),
  bad('w14-wrong-gene-restate', 'wrong-gene', 'avoid', ex(restate('For drugv the guideline gives a Strong recommendation for patients with GENEB Synthetic Poor.')), 'S2'),
  bad('w15-wrong-gene-gloss', 'wrong-gene', 'two', ex(gloss('Both genes affect clearance of drugz and GENEB.')), 'S3'),
  bad('w16-advice-watch-patient', 'advice-beyond-guideline', 'dose', ex(gloss('Watch the patient closely for side effects.')), 'S3'),
  bad('w17-advice-refer', 'advice-beyond-guideline', 'avoid', ex(gloss('Refer the patient to a specialist.')), 'S3'),
  bad('w18-advice-should', 'advice-beyond-guideline', 'avoid', ex(gloss('The patient should avoid drugv.')), 'S5'),
  bad('w19-altered-quote', 'altered-quote', 'avoid', ex({ kind: 'quote', field: 'recommendationText', startByte: 0, endByte: 12, text: 'Avoid drugv and alternatives.' }), 'S1'),
  bad('w20-quote-out-of-range', 'altered-quote', 'dose', ex({ kind: 'quote', field: 'recommendationText', startByte: 500, endByte: 520, text: 'Monitor for adverse.' }), 'S1'),
  bad('w21-markup-and-link', 'markup-or-link', 'avoid', ex(gloss('See <b>drugv</b> at https://example.com now.')), 'S6'),
  bad('w22-second-person', 'second-person', 'optional', ex(gloss('You may use a higher dose.')), 'S6'),
  bad('w23-bad-structure-empty', 'bad-structure', 'avoid', { statements: [] }, 'INVALID_STRUCTURE'),
  bad('w24-bad-structure-kind', 'bad-structure', 'avoid', { statements: [{ kind: 'advice', text: 'Avoid drugv.' }] }, 'INVALID_STRUCTURE'),
  bad('w25-too-long', 'too-long', 'avoid', ex(gloss('Reduced enzyme function in the body. '.repeat(14))), 'S6'),
  bad('w26-directive-in-restate', 'directive-in-restate', 'avoid', ex(restate('For drugv the guideline gives a Strong recommendation for patients with GENEA Synthetic Poor, avoid it.')), 'S2'),
];
