import type { Request, Response } from 'express';
import { authorityContextMiddleware, capabilityAbsentReason, currentRequestCapability } from '../auth/authority-context';
import { CapabilityIssueError, type CapabilityIssueRequest, CapabilityIssuerPort, type IssuedCapability, NullCapabilityIssuer } from './capability-issuer.port';
import { RequestCapabilities } from './request-capabilities';

/** DATA-01 T017: the guard obtains ONE capability per request. A missing one never fails a request in `guc` mode; it is recorded, with its reason. */
const inRequest = async <T>(work: () => Promise<T>): Promise<T> => {
  let result!: Promise<T>;
  authorityContextMiddleware({ id: 'req-oncer-001' } as unknown as Request, {} as Response, () => {
    result = work();
  });
  return result;
};
const withBudget = (capabilities: RequestCapabilities, ms: number) => {
  capabilities.timeoutMs = ms;
  return capabilities;
};
const ask = (over: Partial<CapabilityIssueRequest> = {}): CapabilityIssueRequest => ({ accessToken: 'opaque', membershipVersion: 2, requestId: 'req-oncer-001', ...over });

class Recorder extends CapabilityIssuerPort {
  readonly requests: CapabilityIssueRequest[] = [];
  next: () => Promise<IssuedCapability | undefined> = async () => ({ token: `${this.requests.length}`.padStart(43, 'T'), expiresAt: new Date('2030-01-01T00:00:00Z') });
  async issue(request: CapabilityIssueRequest) {
    this.requests.push(request);
    return this.next();
  }
}

describe('RequestCapabilities.obtain', () => {
  it('asks the issuer once and keeps the answer for the whole request, however often it is called', async () => {
    const port = new Recorder();
    const capabilities = new RequestCapabilities(port);
    await inRequest(async () => {
      await capabilities.obtain(ask());
      const first = currentRequestCapability();
      await capabilities.obtain(ask());
      await capabilities.obtain(ask());
      expect(currentRequestCapability()).toBe(first);
      expect(capabilityAbsentReason()).toBeUndefined();
    });
    expect(port.requests).toHaveLength(1);
    expect(port.requests[0]).toEqual(ask());
  });

  it('a second request is a new issuance', async () => {
    const port = new Recorder();
    const capabilities = new RequestCapabilities(port);
    await inRequest(() => capabilities.obtain(ask()));
    await inRequest(() => capabilities.obtain(ask()));
    expect(port.requests).toHaveLength(2);
  });

  it('the default issuer mints nothing: the request carries on without a capability, and the reason is "not-configured"', async () => {
    await inRequest(async () => {
      await new RequestCapabilities(new NullCapabilityIssuer()).obtain(ask());
      expect(currentRequestCapability()).toBeUndefined();
      expect(capabilityAbsentReason()).toBe('not-configured');
    });
  });

  it.each([
    ['invalid-token', undefined, 'issuer-invalid-token'],
    ['refused', 'membership-not-current', 'issuer-refused'],
    ['unavailable', undefined, 'issuer-unavailable'],
  ] as const)('an issuer failure (%s) does not fail the request; the reason is recorded', async (reason, detail, expected) => {
    const port = new Recorder();
    port.next = async () => {
      throw new CapabilityIssueError(reason, detail);
    };
    await inRequest(async () => {
      await expect(new RequestCapabilities(port).obtain(ask())).resolves.toBeUndefined();
      expect(currentRequestCapability()).toBeUndefined();
      expect(capabilityAbsentReason()).toBe(expected);
    });
  });

  it('an unexpected error from the issuer is recorded the same way, not thrown', async () => {
    const port = new Recorder();
    port.next = async () => {
      throw new TypeError('boom');
    };
    await inRequest(async () => {
      await new RequestCapabilities(port).obtain(ask());
      expect(capabilityAbsentReason()).toBe('issuer-unavailable');
    });
  });

  it('an issuer that answers with a malformed token is treated as a failure, and nothing is bound', async () => {
    const port = new Recorder();
    port.next = async () => ({ token: 'not-a-token', expiresAt: new Date() });
    await inRequest(async () => {
      await new RequestCapabilities(port).obtain(ask());
      expect(currentRequestCapability()).toBeUndefined();
      expect(capabilityAbsentReason()).toBe('issuer-unavailable');
    });
  });
});

describe('RequestCapabilities.obtain: a port that does not answer', () => {
  it('does not hold the request: after the budget the request goes on, labelled "issuer-unavailable", and a late answer is ignored', async () => {
    const port = new Recorder();
    let late!: (value: IssuedCapability) => void;
    port.next = () => new Promise<IssuedCapability | undefined>((resolve) => {
      late = resolve;
    });
    const started = Date.now();
    await inRequest(async () => {
      await withBudget(new RequestCapabilities(port), 30).obtain(ask());
      expect(Date.now() - started).toBeLessThan(1000);
      expect(currentRequestCapability()).toBeUndefined();
      expect(capabilityAbsentReason()).toBe('issuer-unavailable');
      late({ token: 'L'.repeat(43), expiresAt: new Date('2030-01-01T00:00:00Z') });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(currentRequestCapability()).toBeUndefined(); // too late to be bound
    });
  });

  it('control: an answer inside the budget is bound', async () => {
    const port = new Recorder();
    await inRequest(async () => {
      await withBudget(new RequestCapabilities(port), 1000).obtain(ask());
      expect(currentRequestCapability()).toBeDefined();
    });
  });

  it('a late failure after the budget is not an unhandled rejection', async () => {
    const port = new Recorder();
    let fail!: (e: Error) => void;
    port.next = () => new Promise<IssuedCapability | undefined>((_resolve, reject) => {
      fail = reject;
    });
    const unhandled = jest.fn();
    process.once('unhandledRejection', unhandled);
    await inRequest(() => withBudget(new RequestCapabilities(port), 10).obtain(ask()));
    fail(new Error('late'));
    await new Promise((resolve) => setTimeout(resolve, 30));
    process.removeListener('unhandledRejection', unhandled);
    expect(unhandled).not.toHaveBeenCalled();
  });
});
