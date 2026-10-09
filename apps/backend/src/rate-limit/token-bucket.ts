/**
 * A token-bucket limiter with BOUNDED memory. Each key gets `capacity` tokens that refill continuously at `refillPerSecond`; a request costs one.
 * Memory is bounded two ways: a hard cap on keys (the least recently used key is dropped when the cap is exceeded, so a flood of
 * made-up keys cannot grow the process without limit) and `sweep()`, which forgets keys whose bucket has refilled completely (they are
 * indistinguishable from a key never seen). In-process only: see docs/ops/rate-limiting.md for what that does and does not give.
 */
export interface TokenBucketOptions {
  /** Burst size: the most requests that can be made at once from a full bucket. */
  capacity: number;
  refillPerSecond: number;
  /** Hard cap on remembered keys. */
  maxKeys: number;
  /** Milliseconds; injectable so tests control time. */
  now?: () => number;
}

export interface Decision {
  allowed: boolean;
  /** Whole seconds until a request would be allowed; 0 when it was allowed. */
  retryAfterSeconds: number;
}

interface Bucket {
  tokens: number;
  at: number;
}

export class TokenBucketLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly now: () => number;

  constructor(private readonly options: TokenBucketOptions) {
    this.now = options.now ?? Date.now;
  }

  get size(): number {
    return this.buckets.size;
  }

  take(key: string): Decision {
    const { capacity, refillPerSecond, maxKeys } = this.options;
    const now = this.now();
    const known = this.buckets.get(key);
    // Map keeps insertion order: delete and re-insert on every use, so the FIRST key is always the least recently used.
    this.buckets.delete(key);
    const bucket: Bucket = known
      ? { tokens: Math.min(capacity, known.tokens + ((now - known.at) / 1000) * refillPerSecond), at: now }
      : { tokens: capacity, at: now };
    this.buckets.set(key, bucket);
    if (this.buckets.size > maxKeys) {
      const oldest = this.buckets.keys().next().value;
      if (oldest !== undefined) this.buckets.delete(oldest);
    }
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return { allowed: true, retryAfterSeconds: 0 };
    }
    return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((1 - bucket.tokens) / refillPerSecond)) };
  }

  /** Forgets every bucket that has refilled completely. Returns how many were dropped. */
  sweep(): number {
    const { capacity, refillPerSecond } = this.options;
    const now = this.now();
    let dropped = 0;
    for (const [key, bucket] of this.buckets) {
      if (bucket.tokens + ((now - bucket.at) / 1000) * refillPerSecond >= capacity) {
        this.buckets.delete(key);
        dropped += 1;
      }
    }
    return dropped;
  }
}
