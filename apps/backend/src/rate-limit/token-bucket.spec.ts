import { TokenBucketLimiter } from './token-bucket';

// Bucket arithmetic with a clock the test controls. Synthetic keys only.
function limiter(over: Partial<ConstructorParameters<typeof TokenBucketLimiter>[0]> = {}) {
  const clock = { t: 1_000_000 };
  const bucket = new TokenBucketLimiter({ capacity: 3, refillPerSecond: 1, maxKeys: 100, now: () => clock.t, ...over });
  return { bucket, clock };
}

describe('TokenBucketLimiter', () => {
  it('allows a burst up to the capacity, and refuses the next request with a whole-second Retry-After', () => {
    const { bucket } = limiter();
    for (let i = 0; i < 3; i++) expect(bucket.take('a')).toEqual({ allowed: true, retryAfterSeconds: 0 });
    expect(bucket.take('a')).toEqual({ allowed: false, retryAfterSeconds: 1 });
  });

  it('refills continuously: after exactly one refill period a request is allowed again, and not a moment before', () => {
    const { bucket, clock } = limiter();
    for (let i = 0; i < 3; i++) bucket.take('a');
    expect(bucket.take('a').allowed).toBe(false);
    clock.t += 999;
    expect(bucket.take('a').allowed).toBe(false); // 0.999 of a token: not yet
    clock.t += 1;
    expect(bucket.take('a').allowed).toBe(true); // 1.000 token
    expect(bucket.take('a').allowed).toBe(false);
  });

  it('never refills beyond the capacity, however long it waits', () => {
    const { bucket, clock } = limiter();
    bucket.take('a');
    clock.t += 3_600_000;
    for (let i = 0; i < 3; i++) expect(bucket.take('a').allowed).toBe(true);
    expect(bucket.take('a').allowed).toBe(false);
  });

  it('reports how long to wait when the bucket is deeper in debt than one token', () => {
    const { bucket } = limiter({ capacity: 1, refillPerSecond: 0.1 }); // one token every 10 seconds
    expect(bucket.take('a').allowed).toBe(true);
    expect(bucket.take('a')).toEqual({ allowed: false, retryAfterSeconds: 10 });
  });

  it('keeps keys apart: one key being limited never limits another', () => {
    const { bucket } = limiter();
    for (let i = 0; i < 3; i++) bucket.take('a');
    expect(bucket.take('a').allowed).toBe(false);
    expect(bucket.take('b').allowed).toBe(true);
  });

  it('is bounded: past maxKeys the least recently USED key is dropped, and a key that keeps being used survives', () => {
    const { bucket } = limiter({ maxKeys: 3 });
    bucket.take('a');
    bucket.take('b');
    bucket.take('c');
    bucket.take('a'); // a is now the most recently used
    bucket.take('d'); // over the cap: b (the least recently used) goes
    expect(bucket.size).toBe(3);
    for (let i = 0; i < 2; i++) bucket.take('a');
    expect(bucket.take('a').allowed).toBe(false); // a kept its debt: it was not evicted
    expect(bucket.take('b').allowed).toBe(true); // b was forgotten, so it starts full again
  });

  it('sweep forgets only buckets that have refilled completely', () => {
    const { bucket, clock } = limiter();
    bucket.take('quiet'); // 2 of 3 tokens left
    for (let i = 0; i < 3; i++) bucket.take('busy');
    expect(bucket.sweep()).toBe(0);
    clock.t += 1_000; // quiet: refilled to 3; busy: only 1 of 3
    expect(bucket.sweep()).toBe(1);
    expect(bucket.size).toBe(1);
    expect(bucket.take('busy').allowed).toBe(true);
    expect(bucket.take('busy').allowed).toBe(false);
  });
});
