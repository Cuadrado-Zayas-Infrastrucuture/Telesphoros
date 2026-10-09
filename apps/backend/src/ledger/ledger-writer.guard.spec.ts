import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * Only ledger-writer.ts may call the ledger's append functions. Every other write path has to go through `appendEvent`, which reads the
 * record back and hashes the same projection the verifier will read. A second caller could hash something else and the chain would
 * still be "valid" while saying less than the record does.
 */
const SRC = join(__dirname, '..');
const sources = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sources(path) : /\.(ts|js)$/.test(name) && !/\.spec\.ts$/.test(name) ? [path] : [];
  });

// A CALL (SELECT / PERFORM / FROM), not a mention in a comment or a privilege listing.
const CALL = /\b(SELECT|PERFORM|FROM)\s+(public\.)?ledger_append(_internal)?\b/i;

describe('ledger append guard', () => {
  const files = sources(SRC);
  const callers = (pattern: RegExp) => files.filter((f) => pattern.test(readFileSync(f, 'utf8'))).map((f) => relative(SRC, f).split('\\').join('/'));

  it('scans a real source tree (a floor, so an empty scan cannot pass)', () => {
    expect(files.length).toBeGreaterThan(30);
  });

  it('only ledger/ledger-writer.ts calls ledger_append', () => {
    expect(callers(CALL)).toEqual(['ledger/ledger-writer.ts']);
  });

  it('only ledger/verifier.ts calls ledger_record_checkpoint and ledger_record_incident, and nothing in src calls the redaction function, the global hold or the clearance', () => {
    expect(callers(/\bledger_record_checkpoint\b/)).toEqual(['ledger/verifier.ts']);
    expect(callers(/\bledger_record_incident\b/)).toEqual(['ledger/verifier.ts']);
    expect(callers(/\bredact_event_note\b/)).toEqual([]);
    // A person's act (the operator role, in a runbook), never an API: no application code may open or close a hold.
    expect(callers(/\bledger_set_global_hold\b/)).toEqual([]);
    expect(callers(/\bledger_clear_incident\b/)).toEqual([]);
  });

  it('appendEvent is called from one place only (the Postgres ledger repository), and every call passes the ledger watch\'s gate first', () => {
    expect(callers(/\bawait appendEvent\(/)).toEqual(['storage/postgres/ledger-records.repository.ts']);
    const source = readFileSync(join(SRC, 'storage/postgres/ledger-records.repository.ts'), 'utf8');
    const calls = source.match(/appendEvent\(/g) ?? [];
    expect(calls.length).toBeGreaterThan(0);
    expect(source.match(/appendEvent\(this\.ledger, tenantId, /g) ?? []).toHaveLength(calls.length);
  });

  it('detects a violation (control: the pattern matches a synthetic caller)', () => {
    expect(CALL.test(`await client.query('SELECT ledger_append($1)')`)).toBe(true);
    expect(CALL.test(`await client.query('SELECT ledger_record_checkpoint($1)')`)).toBe(false);
  });
});
