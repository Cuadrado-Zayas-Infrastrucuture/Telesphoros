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

/** A CALL of a named function, not a mention in a comment, an object key or a privilege listing (the same rule as CALL above). */
const callOf = (name: string) => new RegExp(`\\b(SELECT|PERFORM|FROM|CALL)\\s+(public\\.)?${name}\\b`, 'i');

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
    expect(callers(callOf('ledger_record_checkpoint'))).toEqual(['ledger/verifier.ts']);
    expect(callers(callOf('ledger_record_incident'))).toEqual(['ledger/verifier.ts']);
    expect(callers(callOf('redact_event_note'))).toEqual([]);
    // A person's act (the operator role, in a runbook), never an API: no application code may open or close a hold.
    expect(callers(callOf('ledger_set_global_hold'))).toEqual([]);
    expect(callers(callOf('ledger_clear_incident'))).toEqual([]);
  });

  it('the provisioning command names these functions only to READ who may execute them, never to call one', () => {
    // db/provision-logins.ts lists every ledger function by name so it can check each login's privileges with has_function_privilege.
    const source = readFileSync(join(SRC, 'db/provision-logins.ts'), 'utf8');
    expect(source).toMatch(/has_function_privilege/);
    expect(source).not.toMatch(/\b(SELECT|PERFORM|FROM|CALL)\s+(public\.)?ledger_/i);
    expect(source).not.toMatch(/\bredact_event_note\s*\(/);
  });

  it('appendEvent is called from one place only (the Postgres ledger repository), and every call passes the ledger watch\'s gate first', () => {
    expect(callers(/\bawait appendEvent\(/)).toEqual(['storage/postgres/ledger-records.repository.ts']);
    const source = readFileSync(join(SRC, 'storage/postgres/ledger-records.repository.ts'), 'utf8');
    const calls = source.match(/appendEvent\(/g) ?? [];
    expect(calls.length).toBeGreaterThan(0);
    expect(source.match(/appendEvent\(this\.ledger, tenantId, /g) ?? []).toHaveLength(calls.length);
  });

  it('detects a call of each guarded function and ignores a mention (controls)', () => {
    for (const name of ['ledger_record_checkpoint', 'ledger_record_incident', 'redact_event_note', 'ledger_set_global_hold', 'ledger_clear_incident']) {
      expect(callOf(name).test(`await client.query('SELECT ${name}($1)')`)).toBe(true);
      expect(callOf(name).test(`await client.query('SELECT public.${name}($1)')`)).toBe(true);
      expect(callOf(name).test(`${name}: false, // a privilege listing`)).toBe(false);
      expect(callOf(name).test(`// calls ${name} elsewhere`)).toBe(false);
    }
  });

  it('detects a violation (control: the pattern matches a synthetic caller)', () => {
    expect(CALL.test(`await client.query('SELECT ledger_append($1)')`)).toBe(true);
    expect(CALL.test(`await client.query('SELECT ledger_record_checkpoint($1)')`)).toBe(false);
  });
});
