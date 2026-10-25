import { MigrationError, parseCompat } from '../src/db/migrator';

describe('migration compat label', () => {
  it('is breaking when there is no label (the safe default for every migration that already shipped)', () => {
    expect(parseCompat('0099', 'CREATE TABLE t (id int);')).toBe('breaking');
    expect(parseCompat('0099', '-- just a comment\nCREATE TABLE t (id int);')).toBe('breaking');
    expect(parseCompat('0099', '')).toBe('breaking');
  });

  it.each([
    ['expand', '-- compat: expand\nCREATE TABLE t (id int);'],
    ['breaking', '-- compat: breaking\nDROP TABLE t;'],
    ['expand', '\n-- Adds a table.\n-- compat: expand\n\n-- more notes\nCREATE TABLE t (id int);'],
    ['expand', '--compat:expand\nCREATE TABLE t (id int);'],
    ['expand', '   --   compat:    expand   \r\nCREATE TABLE t (id int);'],
  ] as const)('reads %s from the leading comment block', (expected, sql) => {
    expect(parseCompat('0099', sql)).toBe(expected);
  });

  it('ignores a label that is not in the leading comment block', () => {
    expect(parseCompat('0099', 'CREATE TABLE t (id int);\n-- compat: expand\n')).toBe('breaking');
    expect(parseCompat('0099', 'SELECT 1; -- compat: expand\n')).toBe('breaking');
    expect(parseCompat('0099', "-- notes\nSET LOCAL lock_timeout = '2s';\n-- compat: expand\n")).toBe('breaking');
  });

  it.each([
    ['an unknown value', '-- compat: additive\nSELECT 1;'],
    ['an empty value', '-- compat:\nSELECT 1;'],
    ['a value with extra words', '-- compat: expand and more\nSELECT 1;'],
    ['a different case', '-- compat: EXPAND\nSELECT 1;'],
  ])('refuses %s instead of guessing', (_name, sql) => {
    expect(() => parseCompat('0099', sql)).toThrow(MigrationError);
    expect(() => parseCompat('0099', sql)).toThrow(/unknown compat label/);
  });

  it('refuses two labels, even when they agree', () => {
    expect(() => parseCompat('0099', '-- compat: expand\n-- compat: expand\nSELECT 1;')).toThrow(/more than one compat label/);
    expect(() => parseCompat('0099', '-- compat: expand\n-- compat: breaking\nSELECT 1;')).toThrow(/more than one compat label/);
  });
});
