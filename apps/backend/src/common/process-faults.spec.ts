import { EventEmitter } from 'node:events';
import { installProcessFaultHandlers } from './process-faults';

function setup() {
  const target = new EventEmitter();
  const lines: string[] = [];
  const exits: number[] = [];
  installProcessFaultHandlers(target, { service: 'api', write: (line) => lines.push(line), exit: (code) => exits.push(code) });
  return { target, lines, exits };
}

describe('process fault handlers', () => {
  it.each([['uncaughtException'], ['unhandledRejection']])('%s writes one structured line, naming the kind and the error class, and exits 1', (kind) => {
    const { target, lines, exits } = setup();
    target.emit(kind, new TypeError('x'));
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({ level: 'fatal', service: 'api', event: 'process-fault', kind, errorClass: 'TypeError' });
    expect(exits).toEqual([1]);
  });

  it('never writes the message, the stack or a value from the error (a thrown message can carry patient data)', () => {
    const { target, lines } = setup();
    const error = Object.assign(new Error('patient Jane Doe has CYP2D6 *4/*4'), { code: 'ECONNRESET', extra: 'Jane Doe', stack: 'at Jane Doe (file.ts:1)' });
    target.emit('uncaughtException', error);
    expect(lines[0]).not.toContain('Jane');
    expect(lines[0]).not.toContain('CYP2D6');
    expect(JSON.parse(lines[0]!).code).toBe('ECONNRESET'); // a short code is kept: it is how an operator tells the faults apart
  });

  it('treats anything that is not an Error as one class, and drops a code that is not a short code', () => {
    const { target, lines } = setup();
    target.emit('unhandledRejection', 'patient Jane Doe');
    expect(JSON.parse(lines[0]!)).toMatchObject({ errorClass: 'non-error' });
    expect(lines[0]).not.toContain('Jane');
    const second = setup();
    second.target.emit('uncaughtException', Object.assign(new Error('x'), { code: 'patient Jane Doe has a long free-text code' }));
    expect(JSON.parse(second.lines[0]!)).not.toHaveProperty('code');
  });

  it('a second fault while exiting writes nothing more and does not exit again', () => {
    const { target, lines, exits } = setup();
    target.emit('uncaughtException', new Error('a'));
    target.emit('unhandledRejection', new Error('b'));
    expect(lines).toHaveLength(1);
    expect(exits).toEqual([1]);
  });

  it('still exits when the line cannot be written', () => {
    const target = new EventEmitter();
    const exits: number[] = [];
    installProcessFaultHandlers(target, { service: 'api', write: () => { throw new Error('EPIPE'); }, exit: (code) => exits.push(code) });
    target.emit('uncaughtException', new Error('x'));
    expect(exits).toEqual([1]);
  });
});
