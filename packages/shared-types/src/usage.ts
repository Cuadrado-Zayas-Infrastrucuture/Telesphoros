import { z } from 'zod';

const count = z.number().int().nonnegative();

/** One calendar month in Puerto Rico time, as `YYYY-MM`: what the organization did in it. */
export const usageMonthSchema = z.strictObject({
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
  /** Reports whose upload completed in the month, including any deleted since. */
  reportsUploaded: count,
  /** Evaluation records created in the month: with results shown, and held. */
  evaluations: z.strictObject({ evaluated: count, held: count }),
});
export type UsageMonth = z.infer<typeof usageMonthSchema>;

/**
 * `GET /usage` (admin only): the caller's own organization, in counts only. `months` is this month so far, then last month. `storage` is the
 * uploaded, not deleted report files now, from their records (not the bucket, so retained old versions are not in it).
 */
export const usageDtoSchema = z.strictObject({
  timeZone: z.literal('America/Puerto_Rico'),
  months: z.tuple([usageMonthSchema, usageMonthSchema]),
  storage: z.strictObject({ reportFiles: count, reportBytes: count }),
});
export type UsageDto = z.infer<typeof usageDtoSchema>;
