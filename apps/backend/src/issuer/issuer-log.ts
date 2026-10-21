import type { LoggerService } from '@nestjs/common';

/**
 * The issuer process's only log writer: Nest's static `Logger` is pointed here (main.ts), so `IssuerCore`'s `Capability not issued: <reason>` lines, the
 * server's own lines and the token verifier's all come out as one plain-text line on stdout. The message text is written unchanged (issuer.tf's two metric
 * filters match the phrases inside it) and there is no colour code in the way.
 *
 * What it will not write: an error object, a stack, or any field of an object other than a short `event` code. The token verifier logs
 * `{ event, error }` when the key set is unreachable, and an error from the network layer can carry an address.
 */
const SAFE_CODE = /^[A-Za-z0-9._:-]{1,96}$/;
const MAX_MESSAGE = 300;

const oneLine = (text: string): string => text.replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, ' ').slice(0, MAX_MESSAGE);

function render(message: unknown): string {
  if (typeof message === 'string') return oneLine(message);
  if (message && typeof message === 'object') {
    const event = (message as { event?: unknown }).event;
    return typeof event === 'string' && SAFE_CODE.test(event) ? `event=${event}` : '-';
  }
  return '-';
}

export class IssuerLogger implements LoggerService {
  constructor(private readonly write: (line: string) => void = (line) => void process.stdout.write(`${line}\n`)) {}

  log(message: unknown, ...params: unknown[]): void {
    this.line('LOG', message, params);
  }
  warn(message: unknown, ...params: unknown[]): void {
    this.line('WARN', message, params);
  }
  error(message: unknown, ...params: unknown[]): void {
    this.line('ERROR', message, params);
  }
  fatal(message: unknown, ...params: unknown[]): void {
    this.line('FATAL', message, params);
  }

  private line(level: string, message: unknown, params: unknown[]): void {
    // Nest appends the logger's context as the last string parameter. For `error` the one before it is a stack, which is never written.
    const strings = params.filter((p): p is string => typeof p === 'string');
    const last = strings.at(-1);
    const context = last !== undefined && SAFE_CODE.test(last) ? last : 'App';
    const extra = level === 'ERROR' ? [] : strings.slice(0, last !== undefined && SAFE_CODE.test(last) ? -1 : undefined);
    const text = [render(message), ...extra.map(oneLine)].join(' ');
    this.write(`${new Date().toISOString()} ${level} [${context}] ${text}`);
  }
}
