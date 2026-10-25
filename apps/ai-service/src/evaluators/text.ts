/** Lower-case words (letters first, digits allowed) and standalone numerals. Hyphens and punctuation separate tokens. */
export const words = (s: string): string[] => (s.toLowerCase().match(/[a-z][a-z0-9]*/g) ?? []);
export const numerals = (s: string): string[] => (s.match(/\d+(?:\.\d+)?/g) ?? []);
export const NUMBER_WORDS = new Set(['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'half', 'quarter', 'third', 'twice', 'double', 'triple', 'once', 'hundred', 'thousand']);
