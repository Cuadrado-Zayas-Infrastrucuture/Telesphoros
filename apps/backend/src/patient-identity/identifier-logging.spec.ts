import type { IncomingMessage } from 'node:http';
import { pinoHttpOptions } from '../logger-options';

/**
 * An identifier's value arrives in a request body and must never reach a log. The request logger names only the request id and method (and the
 * route template, set elsewhere), so a body, a query string or a path parameter cannot be written by it. This pins that for the shape of a real
 * identifier request, and shows the check can fail (a control with a serializer that does log the body).
 */
describe('logging a request that carries an identifier', () => {
  const request = {
    id: 'req-1',
    method: 'POST',
    url: '/api/v1/patients/0f2c8a64-2d6a-4a3e-8f3e-0b7a9d5a3c11/identifiers?value=ZQX-SECRET',
    headers: { authorization: 'Bearer secret-token', 'content-type': 'application/json' },
    body: { system: 'hospital-a-mrn', value: 'ZQX-SECRET-123' },
  } as unknown as IncomingMessage & { id: string };

  it('writes the id and the method and nothing of the body, the query or the headers', () => {
    const serialized = pinoHttpOptions({ LOG_LEVEL: 'info' }).serializers!.req!(request);
    expect(serialized).toEqual({ id: 'req-1', method: 'POST' });
    expect(JSON.stringify(serialized)).not.toMatch(/ZQX|secret|identifiers/i);
  });

  it('control: a serializer that logged the body would be caught by the same assertion', () => {
    const loose = (r: typeof request) => ({ id: r.id, method: r.method, body: (r as unknown as { body: unknown }).body });
    expect(JSON.stringify(loose(request))).toMatch(/ZQX-SECRET-123/);
  });
});
