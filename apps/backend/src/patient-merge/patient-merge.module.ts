import { Module } from '@nestjs/common';
import { PatientDuplicatesController, PatientMergesController } from './patient-merge.controller';
import { PatientMergeService } from './patient-merge.service';

/** Possible duplicates (always on) and the two-person merge of patient records (a ledger record: PostgreSQL only). */
@Module({
  controllers: [PatientDuplicatesController, PatientMergesController],
  providers: [PatientMergeService],
})
export class PatientMergeModule {}
