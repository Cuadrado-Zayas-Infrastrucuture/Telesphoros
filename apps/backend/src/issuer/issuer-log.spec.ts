import { Logger } from '@nestjs/common';
import { IssuerLogger } from './issuer-log';

/**
 * The issuer writes one plain-text line per event to stdout, and the line carries the text of the message unchanged: issuer.tf's two metric filters match
 * the phrases "Capability not issued: unavailable" and "Capability not issued: refused (rate-limited)" inside it. What it must not carry is anything a
 * component below put in an object or an error (the verifier logs `{ event, error }`).
 */
const lines: string[] = [];
beforeEach(() => {
  lines.length = 0;
  Logger.overrideLogger(new IssuerLogger((line) => lines.push(line)));
});
afterAll(() => Logger.overrideLogger(['log', 'error', 'warn']));

describe('IssuerLogger', () => {
  it('writes the core\'s message unchanged, in one line, with level and context', () => {
    new Logger('SessionIssuer').warn('Capability not issued: refused (rate-limited) request=req-1');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z WARN \[SessionIssuer\] Capability not issued: refused \(rate-limited\) request=req-1$/);
    new Logger('SessionIssuer').warn('Capability not issued: unavailable (Error)');
    expect(lines[1]).toContain('Capability not issued: unavailable');
  });

  it('prints only the event of an object message and drops the error beside it', () => {
    const error = Object.assign(new Error('connect ECONNREFUSED 10.1.2.3:443 secret-detail-sentinel'), { address: '10.1.2.3' });
    new Logger('CognitoTokenVerifier').warn({ event: 'token-key-set-unavailable', error }, 'Could not verify a token because the key set was unavailable');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('event=token-key-set-unavailable');
    expect(lines[0]).toContain('[CognitoTokenVerifier]');
    expect(lines[0]).not.toContain('secret-detail-sentinel');
    expect(lines[0]).not.toContain('10.1.2.3');
  });

  it('drops a stack, and an object without a safe event becomes a dash', () => {
    new Logger('X').error('failed', 'stack-sentinel at /app/dist/file.js:1:1');
    expect(lines[0]).not.toContain('stack-sentinel');
    new Logger('X').warn({ anything: 'else-sentinel', event: 'has spaces and secrets' });
    expect(lines[1]).toMatch(/\[X\] -$/);
    expect(lines[1]).not.toContain('sentinel');
  });

  it('cannot be made to write a second line: control characters become spaces, and the length is capped', () => {
    new Logger('X').warn('first\nforged line\r\nWARN [Y] Capability not issued: unavailable');
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toMatch(/[\r\n]/);
    new Logger('X').warn('a'.repeat(5000));
    expect(lines[1]!.length).toBeLessThan(400);
  });

  it('writes nothing below log level', () => {
    new Logger('X').debug('debug-sentinel');
    new Logger('X').verbose('verbose-sentinel');
    expect(lines).toEqual([]);
    new Logger('X').log('visible');
    expect(lines).toHaveLength(1); // control: the capture works
  });
});
