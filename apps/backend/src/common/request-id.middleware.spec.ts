import type { Request, Response } from 'express';
import { requestIdMiddleware } from './request-id.middleware';

function run(headerValue?: string | string[]) {
  const headers: Record<string, string> = {};
  const req = { headers: headerValue === undefined ? {} : { 'x-request-id': headerValue } } as unknown as Request;
  const res = { setHeader: (k: string, v: string) => { headers[k] = v; } } as unknown as Response;
  const next = jest.fn();
  requestIdMiddleware(req, res, next);
  return { id: req.id, headers, next };
}

describe('requestIdMiddleware', () => {
  it('generates a uuid when none is supplied, sets the response header, and calls next', () => {
    const { id, headers, next } = run();
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(headers['X-Request-Id']).toBe(id);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('keeps a safe supplied id, using the first value if the header repeats', () => {
    expect(run('client-id-12345').id).toBe('client-id-12345');
    expect(run(['first-id-12345', 'second-id-12345']).id).toBe('first-id-12345');
  });

  it.each(['short', 'bad id with spaces', 'x'.repeat(65), 'line\nbreak-injection', ''])(
    'replaces an unsafe id (%j) with a generated one',
    (unsafe) => {
      const { id } = run(unsafe);
      expect(id).toMatch(/^[0-9a-f-]{36}$/);
    },
  );
});
