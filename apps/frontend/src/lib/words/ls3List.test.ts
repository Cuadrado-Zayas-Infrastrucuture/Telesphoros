import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AnyWordTable, WordValue } from './defineWords';
import { SCREEN_TABLES } from './index';

// Spec 050 LS3a: docs/design/spanish/ls3-patient.md lists every fixed string of the `patient` screen's word tables for the founders to translate.
// This keeps it in step with the tables: a string added, removed or changed in the code without its row there fails here.

const LIST = resolve(__dirname, '../../../../../docs/design/spanish/ls3-patient.md');

/** The English as the list shows it: a function's placeholders as {1}, {2}. */
const shown = (value: WordValue) => (typeof value === 'function' ? (value as (...args: string[]) => string)(...['{1}', '{2}', '{3}']) : value);

function expectedRows(tables: readonly AnyWordTable[]): Map<string, string> {
  const rows = new Map<string, string>();
  for (const table of tables) for (const [key, value] of Object.entries(table.en)) rows.set(`${table.id}.${key}`, shown(value));
  return rows;
}

/** The list's rows of word-table strings: `| \`id.key\` | English | Spanish |`. */
function listedRows(text: string): Map<string, string> {
  const rows = new Map<string, string>();
  for (const line of text.split('\n')) {
    const match = /^\| `([^`]+)` \| (.*?) \| (.*?) \|/.exec(line);
    if (!match) continue;
    rows.set(match[1]!, match[2]!);
  }
  return rows;
}

/** What differs between the list and the tables: a missing row, an extra row, or a different English. */
function listProblems(expected: Map<string, string>, listed: Map<string, string>): string[] {
  const problems: string[] = [];
  for (const [key, english] of expected) {
    if (!listed.has(key)) problems.push(`${key}: no row in the list`);
    else if (listed.get(key) !== english) problems.push(`${key}: the list says "${listed.get(key)}", the table "${english}"`);
  }
  for (const key of listed.keys()) if (!expected.has(key)) problems.push(`${key}: a row with no string in the tables`);
  return problems;
}

describe('the LS3 list for the founders', () => {
  const expected = expectedRows(SCREEN_TABLES.patient);
  const text = readFileSync(LIST, 'utf8');

  it('has a row for every string of the patient tables, with its English exactly, and no other row', () => {
    expect(SCREEN_TABLES.patient.map((table) => table.id)).toEqual([
      'patient-identity',
      'patient-page',
      'patient-banner',
      'patient-demographics',
      'patient-medications',
      'patient-results',
    ]);
    expect(expected.size).toBeGreaterThan(0);
    expect(listProblems(expected, listedRows(text))).toEqual([]);
  });

  it('control: a changed English string, a missing row and an extra row are each caught', () => {
    const changed = text.replace('| `patient-page.heading` | Patient |', '| `patient-page.heading` | Chart |');
    expect(listProblems(expected, listedRows(changed))).toEqual([expect.stringContaining('patient-page.heading: the list says "Chart"')]);
    const missing = text.replace(/^\| `patient-medications\.add` .*$/m, '');
    expect(listProblems(expected, listedRows(missing))).toEqual(['patient-medications.add: no row in the list']);
    const extra = `${text}\n| \`patient-page.extra\` | Extra |  |\n`;
    expect(listProblems(expected, listedRows(extra))).toEqual(['patient-page.extra: a row with no string in the tables']);
  });
});
