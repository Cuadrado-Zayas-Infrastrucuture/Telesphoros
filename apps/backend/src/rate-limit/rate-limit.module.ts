import { Module } from '@nestjs/common';
import { ENV, type Env } from '../config/env';
import { RATE_LIMIT_CONFIG, type RateLimitConfig, RateLimitService } from './rate-limit.service';

/** Remembered keys per limiter. A hard cap, so a flood of made-up addresses cannot grow the process without limit. */
const MAX_KEYS = 50_000;

/** Provides the limits; the two guards that use them are registered by AuthModule, which fixes their order around authentication. */
@Module({
  providers: [
    {
      provide: RATE_LIMIT_CONFIG,
      inject: [ENV],
      useFactory: (env: Env): RateLimitConfig => ({
        enabled: env.RATE_LIMIT_ENABLED,
        ipPerMinute: env.RATE_LIMIT_IP_PER_MINUTE,
        perMinute: { read: env.RATE_LIMIT_READ_PER_MINUTE, write: env.RATE_LIMIT_WRITE_PER_MINUTE, expensive: env.RATE_LIMIT_EXPENSIVE_PER_MINUTE },
        maxKeys: MAX_KEYS,
      }),
    },
    RateLimitService,
  ],
  exports: [RateLimitService],
})
export class RateLimitModule {}
