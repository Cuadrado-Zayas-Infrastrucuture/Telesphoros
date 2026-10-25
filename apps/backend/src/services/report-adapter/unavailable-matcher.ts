/**
 * The R06 matcher (docs/design/report-adapter-spec.md, section 5.5): does a reported result say "no result available"?
 *
 * It is a custom comparison with exactly seven tokens, not a claim of general Unicode equivalence, and it compares a
 * normalized COPY: the reported text is never changed. The Unicode version is pinned: a runtime whose data is not
 * Unicode 16.0 cannot silently change the results, so this module refuses to load on one. When Node's Unicode data moves,
 * re-run the conformance tests and change the pin deliberately.
 */
const REQUIRED_UNICODE_VERSION = '16.0';
if (process.versions.unicode !== REQUIRED_UNICODE_VERSION) {
  throw new Error(`The unavailable-value matcher is pinned to Unicode ${REQUIRED_UNICODE_VERSION}, but this runtime has ${process.versions.unicode}.`);
}

/** Already normalized, and exactly these. A new token needs a source example, a version change, conformance cases and review. */
export const UNAVAILABLE_TOKENS: readonly string[] = ['not available', 'not reported', 'pending', 'no disponible', 'resultado no disponible', 'no reportado', 'pendiente'];
const TOKEN_SET: ReadonlySet<string> = new Set(UNAVAILABLE_TOKENS);

/** The explicit Unicode 16.0.0 White_Space set (U+0009 to U+000D, U+0020, U+0085, U+00A0, U+1680, U+2000 to U+200A, U+2028, U+2029, U+202F, U+205F, U+3000). */
// eslint-disable-next-line no-control-regex -- the Unicode White_Space set deliberately includes U+0009 to U+000D
const WHITE_SPACE_RUN = /[\u0009-\u000D\u0020\u0085\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000]+/g;

/**
 * Full case folding, restricted. JavaScript has no full fold, and every token is ASCII, so only the characters whose full
 * fold is ASCII-only can matter: A to Z, and these eleven. Any other non-ASCII character cannot reach a token, folded or not.
 * A test derives this set independently, across every code point, and fails if it differs. A non-ASCII token added later
 * needs the real full fold.
 */
export const ASCII_ONLY_FULL_FOLDS: Readonly<Record<string, string>> = {
  '\u00DF': 'ss', // sharp s
  '\u017F': 's', // long s
  '\u1E9E': 'ss', // capital sharp s
  '\u212A': 'k', // Kelvin sign
  '\uFB00': 'ff',
  '\uFB01': 'fi',
  '\uFB02': 'fl',
  '\uFB03': 'ffi',
  '\uFB04': 'ffl',
  '\uFB05': 'st',
  '\uFB06': 'st',
};

function fold(text: string): string {
  let out = '';
  for (const char of text) {
    if (char >= 'A' && char <= 'Z') out += char.toLowerCase();
    else out += ASCII_ONLY_FULL_FOLDS[char] ?? char;
  }
  return out;
}

/** The comparison copy: NFC, White_Space runs to one U+0020, trim U+0020, fold, then remove exactly one terminal period (and do not trim again). */
export function comparisonCopy(text: string): string {
  const collapsed = text
    .normalize('NFC')
    .replace(WHITE_SPACE_RUN, ' ')
    .replace(/^ +| +$/g, '');
  const folded = fold(collapsed);
  return folded.endsWith('.') ? folded.slice(0, -1) : folded;
}

/** True only for one of the seven tokens after the fixed sequence. Quotation marks are part of the value, so a quoted value never matches. */
export function isUnavailableValue(text: string): boolean {
  return TOKEN_SET.has(comparisonCopy(text));
}
