import { Module } from '@nestjs/common';
import { Database } from '../db/database';
import { AccessReviewController } from './access-review.controller';
import { AccessReviewRepository, PostgresAccessReviewRepository, UnavailableAccessReviewRepository } from './access-review.repository';

/** Spec 046. The access audit exists only on PostgreSQL; without it the review answers 503. */
@Module({
  controllers: [AccessReviewController],
  providers: [
    {
      provide: AccessReviewRepository,
      inject: [{ token: Database, optional: true }],
      useFactory: (database?: Database) => (database ? new PostgresAccessReviewRepository(database) : new UnavailableAccessReviewRepository()),
    },
  ],
})
export class AccessReviewModule {}
