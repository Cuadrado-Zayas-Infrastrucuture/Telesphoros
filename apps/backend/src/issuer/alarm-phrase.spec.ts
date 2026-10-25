import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { BACKEND_ROOT } from '../../test/helpers/import-closure';
import { CapabilityIssueError, type CapabilityIssueFailure } from './capability-issuer.port';

/**
 * DATA-01: one failed issuance is counted once. issuer.tf's two CloudWatch metric filters count the issuer log lines `Capability not issued: unavailable` and
 * `Capability not issued: refused (rate-limited)`, and `IssuerCore` is the only code that writes them. Anything else that wrote the phrase, say a future
 * `logger.error(err.message)` in the API (the API's log group is not the issuer's, but the phrase would be on a log line that reads like the alarm's), would
 * make one failure look like two. So the phrase belongs to the issuer core alone:
 *
 *   1. no `CapabilityIssueError` message carries it, whatever the reason or detail, because that message is the text a careless log call would write;
 *   2. no non-test source under `src` outside `issuer-core.ts` writes it (a line that is only a comment does not count: a comment is never logged).
 *
 * LIMIT, on purpose: the scan reads the text of each line for the phrase itself. A phrase assembled at run time (`'Capability not ' + 'issued'`, a join, a
 * constant in another file) is not seen. The first check does not have that gap for the one source that matters, the error's own message, because it builds
 * the error and reads what comes out. issuer.guard.test.mjs separately ties the core's own literals to the two filters, so a changed core literal turns that
 * guard red instead of leaving the alarms counting nothing.
 */
const ALARM_PHRASE = /capability\s+not\s+issued/i;
const CORE = 'src/issuer/issuer-core.ts';

const REASONS: CapabilityIssueFailure[] = ['invalid-token', 'no-tenant', 'invalid-request', 'refused', 'unavailable'];
const DETAILS = [undefined, 'rate-limited', 'membership-not-current', 'timeout', 'server'];

/** Paths are relative to `apps/backend`, with `/` separators, whatever the platform. */
export function phraseWriters(files: Record<string, string>): string[] {
  const problems: string[] = [];
  for (const [path, text] of Object.entries(files)) {
    if (path === CORE) continue;
    text.split('\n').forEach((line, index) => {
      const code = line.trimStart();
      if (code.startsWith('//') || code.startsWith('/*') || code.startsWith('*')) return; // comment lines are never logged
      if (ALARM_PHRASE.test(line)) problems.push(`${path}:${index + 1} writes the issuer's alarm phrase, which only ${CORE} may write`);
    });
  }
  return problems;
}

function sourcesUnder(dir: string): Record<string, string> {
  const found: Record<string, string> = {};
  const walk = (current: string) => {
    for (const name of readdirSync(current)) {
      const full = join(current, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (name.endsWith('.ts') && !name.endsWith('.spec.ts') && !name.endsWith('.d.ts')) found[relative(BACKEND_ROOT, full).split(sep).join('/')] = readFileSync(full, 'utf8');
    }
  };
  walk(dir);
  return found;
}

describe('the alarm phrase belongs to the issuer core', () => {
  it('no CapabilityIssueError message carries the phrase, for any reason or detail', () => {
    let built = 0;
    for (const reason of REASONS) {
      for (const detail of DETAILS) {
        const error = new CapabilityIssueError(reason, detail);
        expect([reason, detail, ALARM_PHRASE.test(error.message)]).toEqual([reason, detail, false]);
        expect(error.message.length).toBeGreaterThan(0); // control: there is a message to inspect
        if (reason !== 'invalid-token') expect(error.message).toContain(reason); // control: the message is the one built from the reason
        built += 1;
      }
    }
    expect(built).toBe(REASONS.length * DETAILS.length); // 25 of 25
    expect(new CapabilityIssueError('invalid-token').message).toBe('Invalid token'); // the one generic message callers see is unchanged
  });

  it('no source outside the core writes the phrase', () => {
    const files = sourcesUnder(join(BACKEND_ROOT, 'src'));
    const names = Object.keys(files);
    expect(names.length).toBeGreaterThan(100); // control: the whole tree was read, not one folder
    for (const expected of [
      'src/issuer/capability-issuer.port.ts',
      'src/issuer/issuer-http-client.ts',
      'src/issuer/request-capabilities.ts',
      'src/issuer/issuer-server.ts',
      CORE,
    ]) {
      expect([expected, names.includes(expected)]).toEqual([expected, true]);
    }
    expect(names.some((n) => n.endsWith('.spec.ts'))).toBe(false); // tests may name the phrase: they assert on the issuer's lines
    expect(ALARM_PHRASE.test(files[CORE])).toBe(true); // control: the phrase the scan looks for is the one the core writes, so a clean result means something
    expect(phraseWriters(files)).toEqual([]);
  });

  it('the scan reports a writer wherever it hides (controls)', () => {
    const clean = { [CORE]: 'this.logger.warn(`Capability not issued: ${reason}`);', 'src/a.ts': 'const x = 1;' };
    expect(phraseWriters(clean)).toEqual([]); // control: the core itself is allowed
    const writers: [string, Record<string, string>][] = [
      ['a single-quoted literal', { ...clean, 'src/a.ts': "logger.error('Capability not issued: unavailable');" }],
      ['a template literal', { ...clean, 'src/a.ts': 'logger.error(`Capability not issued: ${reason}`);' }],
      ['another case', { ...clean, 'src/a.ts': "logger.error('CAPABILITY NOT ISSUED');" }],
      ['a doubled space', { ...clean, 'src/a.ts': "logger.error('Capability  not issued');" }],
      ['the port itself', { ...clean, 'src/issuer/capability-issuer.port.ts': 'super(`Capability not issued: ${reason}`);' }],
      ['the client', { ...clean, 'src/issuer/issuer-http-client.ts': "this.logger.warn('Capability not issued: unavailable');" }],
      ['a trailing comment after code', { ...clean, 'src/a.ts': "log('x'); // Capability not issued" }],
      ["a file that only has the core's file name", { ...clean, 'src/other/issuer-core.ts': "log('Capability not issued: unavailable');" }],
      ['a second core-looking path', { ...clean, 'src/issuer/issuer-core.ts.bak.ts': "log('Capability not issued: unavailable');" }],
    ];
    for (const [name, files] of writers) expect([name, phraseWriters(files).length > 0]).toEqual([name, true]);
    // Comment lines are not writers.
    const comments = { ...clean, 'src/a.ts': '// Capability not issued: unavailable\n/** Capability not issued: x */\n/*\n * Capability not issued\n */' };
    expect(phraseWriters(comments)).toEqual([]);
  });

  it('the scan sees the phrase in every position of a real line count', () => {
    const files = { 'src/a.ts': 'one\ntwo\nlog("Capability not issued");' };
    expect(phraseWriters(files)).toEqual(["src/a.ts:3 writes the issuer's alarm phrase, which only src/issuer/issuer-core.ts may write"]);
  });

  it('the files this spec reads exist where it looks', () => {
    expect(existsSync(join(BACKEND_ROOT, CORE))).toBe(true);
  });
});
