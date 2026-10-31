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

/** A calendar date in Puerto Rico time, as `YYYY-MM-DD`. */
const puertoRicoDate = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/);

/** `GET /usage/days` (specs/028-usage-heatmap): a four-digit year. With none, the current Puerto Rico year. */
export const usageDaysQuerySchema = z.strictObject({
  year: z
    .string()
    .regex(/^\d{4}$/)
    .transform(Number)
    .optional(),
});
export type UsageDaysQuery = z.infer<typeof usageDaysQuerySchema>;

/**
 * `GET /usage/days` (admin only, specs/028-usage-heatmap D6 with A1): reports uploaded per Puerto Rico day of one calendar year, for the caller's own
 * organization. `days` lists only days with at least one upload, oldest first. `firstDate` (the day the organization was created) and `today`
 * bound the years that can be asked for and mark the days that cannot have counts. A separate route, so `usageDtoSchema` stays unchanged.
 */
export const usageDaysDtoSchema = z.strictObject({
  timeZone: z.literal('America/Puerto_Rico'),
  year: z.number().int(),
  firstDate: puertoRicoDate,
  today: puertoRicoDate,
  days: z.array(z.strictObject({ date: puertoRicoDate, reportsUploaded: z.number().int().positive() })),
});
export type UsageDaysDto = z.infer<typeof usageDaysDtoSchema>;
