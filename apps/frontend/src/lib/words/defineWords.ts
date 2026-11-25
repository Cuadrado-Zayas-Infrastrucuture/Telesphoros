/*
 * A screen's fixed words, English and Spanish side by side (spec 050, slice LS1, LS-D5). The Spanish, when a table has it, must have exactly the
 * English table's keys: a missing key or an extra one does not compile (R4). A value is a string, or a function of its placeholders, such as the
 * synthetic label, and never an identity value (R9). Every table is listed in `WORD_TABLES` (`./index.ts`) so the checks in `words.test.ts`
 * read them all.
 *
 * The Spanish is written by the founders and never machine translated (R8). A clinical or patient-safety table names two pharmacist signers
 * and a date before its Spanish can be shown (R7).
 */
export type WordValue = string | ((...args: never[]) => string);
export type WordShape = Record<string, WordValue>;

/** The same keys, with each value widened: a Spanish string, or a function taking the same placeholders. */
export type Words<T extends WordShape> = { readonly [K in keyof T]: T[K] extends (...args: infer A) => string ? (...args: A) => string : string };

export interface Signer {
  readonly name: string;
  readonly role: string;
  /** YYYY-MM-DD */
  readonly date: string;
}

export interface WordTable<T extends WordShape> {
  /** A stable name, used in test messages. */
  readonly id: string;
  readonly en: T;
  readonly es?: Words<T>;
  /** Clinical or patient-safety wording: its Spanish needs two pharmacist signers (R7). */
  readonly clinical: boolean;
  readonly signedBy: readonly Signer[];
  /** Pairs of [visible word, accessible name]: the name starts with the visible word, in each language (R10). */
  readonly namePairs: readonly (readonly [keyof T & string, keyof T & string])[];
}

export function defineWords<T extends WordShape>(table: {
  id: string;
  en: T;
  es?: Words<T>;
  clinical?: boolean;
  signedBy?: readonly Signer[];
  namePairs?: readonly (readonly [keyof T & string, keyof T & string])[];
}): WordTable<T> {
  return { id: table.id, en: table.en, es: table.es, clinical: table.clinical ?? false, signedBy: table.signedBy ?? [], namePairs: table.namePairs ?? [] };
}

/** Any table, for the index the checks read: each value a string or a function of its placeholders. */
export interface AnyWordTable {
  readonly id: string;
  readonly en: WordShape;
  readonly es?: WordShape;
  readonly clinical: boolean;
  readonly signedBy: readonly Signer[];
  readonly namePairs: readonly (readonly [string, string])[];
}
