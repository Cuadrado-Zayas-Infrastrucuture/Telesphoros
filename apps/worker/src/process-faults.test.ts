import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { jsonLogger } from './log';
import { installProcessFaultHandlers } from './process-faults';

function setup() {
  const target = new EventEmitter();
  const lines: string[] = [];
  const exits: number[] = [];
  installProcessFaultHandlers(
    target,
    jsonLogger((line) => lines.push(line)),
    (code) => exits.push(code),
  );
  return { target, lines, exits };
}

describe('the worker process fault handlers', () => {
  it.each([['uncaughtException'], ['unhandledRejection']])('%s writes one process-fault line with the kind and the error class, and exits 1', (kind) => {
    const { target, lines, exits } = setup();
    target.emit(kind, new RangeError('x'));
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({ level: 'error', service: 'worker', event: 'process-fault', reason: kind, code: 'RangeError' });
    expect(exits).toEqual([1]);
  });

  it('never writes the message or a value from the error', () => {
    const { target, lines } = setup();
    target.emit('uncaughtException', Object.assign(new Error('patient Jane Doe has CYP2D6 *4/*4'), { code: 'ECONNRESET' }));
    target.emit('unhandledRejection', 'patient Jane Doe');
    expect(lines.join('')).not.toContain('Jane');
    expect(lines.join('')).not.toContain('CYP2D6');
  });

  it('treats anything that is not an Error as one class', () => {
    const { target, lines } = setup();
    target.emit('unhandledRejection', { message: 'patient Jane Doe' });
    expect(JSON.parse(lines[0]!)).toMatchObject({ code: 'non-error' });
  });

  it('a second fault while exiting writes nothing more and does not exit again', () => {
    const { target, lines, exits } = setup();
    target.emit('uncaughtException', new Error('a'));
    target.emit('unhandledRejection', new Error('b'));
    expect(lines).toHaveLength(1);
    expect(exits).toEqual([1]);
  });

  it('still exits when logging throws', () => {
    const target = new EventEmitter();
    const exits: number[] = [];
    installProcessFaultHandlers(
      target,
      () => {
        throw new Error('EPIPE');
      },
      (code) => exits.push(code),
    );
    target.emit('uncaughtException', new Error('x'));
    expect(exits).toEqual([1]);
  });
});
