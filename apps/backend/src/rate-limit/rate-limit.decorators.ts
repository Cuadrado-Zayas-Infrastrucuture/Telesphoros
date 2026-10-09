import { SetMetadata } from '@nestjs/common';
import type { RateClass } from './rate-limit.service';

export const RATE_CLASS_KEY = 'rate-limit:class';
export const SKIP_RATE_LIMIT_KEY = 'rate-limit:skip';

/** Marks a route as costlier (or cheaper) than its HTTP method implies. Reads default to `read`; everything else to `write`. */
export const RateLimitClass = (rateClass: RateClass) => SetMetadata(RATE_CLASS_KEY, rateClass);

/** Exempts a route from rate limiting. Only for liveness/readiness probes, which a load balancer calls on a schedule. */
export const SkipRateLimit = () => SetMetadata(SKIP_RATE_LIMIT_KEY, true);
