import type { ReaderBindings } from './reader-result';

/**
 * The one reader build this repository accepts: the imported hand-off engine (knowledge/lab-report-reader/v2-handoff/engine).
 * These are the values `reader_cli.py bindings` prints for it, and a test recomputes them from the imported files.
 * Changing any of them is a reviewed change that also re-imports the engine (see ORIGIN.md); never edit them to make a
 * mismatch go away.
 */
export const PINNED_READER: Readonly<ReaderBindings> = {
  generatorVersion: 'stage-a/2',
  generatorCodeHash: 'a13175654b831e82cbb92e4e2c4517dce353b38df4ee9bfeb7b2504d0e131be9',
  grammarHash: 'ca076c3bc436928d2e9a8914584ea3e12f63131035ef8345d8f64c50c3fc2ab3',
  offsetContractHash: '8acdb4342da53a214b3f938c0675aef9ef0b95c9bb68485d38ee565ebf7a56e1',
  fieldBoundaryPolicyHash: 'eb861e45d4d5bc7d05988e3ac9b0efc89cbe2a42e25e8a744062fe5fb84169ea',
};

/** The pinned Poppler (`pdftotext -layout`). Captures made with any other version are not comparable (see ORIGIN.md). */
export const PINNED_POPPLER_VERSION = '26.03.0';

/** The names of the bindings that differ from the pinned reader (empty when it is the pinned one). Never values. */
export function bindingMismatches(bindings: ReaderBindings): Array<keyof ReaderBindings> {
  return (Object.keys(PINNED_READER) as Array<keyof ReaderBindings>).filter((key) => bindings[key] !== PINNED_READER[key]);
}
