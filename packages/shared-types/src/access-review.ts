import { z } from 'zod';

/**
 * Spec 046: an organisation admin's review of who read which patient, over the existing application access audit (`security_audit_events`). Ids,
 * route keys, outcomes and times only: no label, no clinical value, no URL (AR-6).
 */
export const ACCESS_REVIEW_PAGE_SIZE = 50;
export const ACCESS_REVIEW_MAX_DAYS = 92;
export const ACCESS_REVIEW_EXPORT_MAX_ROWS = 5000;
const DAY_MS = 86_400_000;

export const accessReviewQuerySchema = z
  .strictObject({
    patientId: z.uuid().optional(),
    member: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[^\p{Cc}]+$/u)
      .optional(),
    from: z.iso.datetime({ offset: true }).optional(),
    to: z.iso.datetime({ offset: true }).optional(),
    page: z.coerce.number().int().min(1).max(100).default(1),
  })
  .superRefine((q, ctx) => {
    if (q.patientId && q.member) ctx.addIssue({ code: 'custom', path: ['member'], message: 'Choose a patient or a member, not both.' });
    const to = q.to ? Date.parse(q.to) : Date.now();
    const from = q.from ? Date.parse(q.from) : to - 30 * DAY_MS;
    if (from >= to) ctx.addIssue({ code: 'custom', path: ['from'], message: 'The start must come before the end.' });
    else if (to - from > ACCESS_REVIEW_MAX_DAYS * DAY_MS) ctx.addIssue({ code: 'custom', path: ['from'], message: `Choose at most ${ACCESS_REVIEW_MAX_DAYS} days.` });
  });
export type AccessReviewQuery = z.infer<typeof accessReviewQuerySchema>;

/** The window a query names: the end defaults to now and the start to 30 days before it. */
export function accessReviewWindow(q: Pick<AccessReviewQuery, 'from' | 'to'>, now = Date.now()): { from: Date; to: Date } {
  const to = q.to ? new Date(q.to) : new Date(now);
  const from = q.from ? new Date(q.from) : new Date(to.getTime() - 30 * DAY_MS);
  return { from, to };
}

export const ACCESS_REVIEW_SUBJECT_KINDS = ['patient', 'evaluation', 'report', 'other'] as const;
export const accessReviewRowSchema = z.strictObject({
  occurredAt: z.iso.datetime(),
  member: z.string(),
  routeKey: z.string(),
  event: z.enum(['private-read', 'download-link']),
  outcome: z.enum(['succeeded', 'refused']),
  subjectKind: z.enum(ACCESS_REVIEW_SUBJECT_KINDS),
  subjectId: z.uuid().nullable(),
  patientId: z.uuid().nullable(),
});
export type AccessReviewRow = z.infer<typeof accessReviewRowSchema>;

export const accessReviewPageSchema = z.strictObject({
  data: z.array(accessReviewRowSchema),
  page: z.int().min(1),
  hasMore: z.boolean(),
  from: z.iso.datetime(),
  to: z.iso.datetime(),
});
export type AccessReviewPage = z.infer<typeof accessReviewPageSchema>;

export const ACCESS_REVIEW_CSV_HEADER = 'occurred_at,member,route_key,event,outcome,subject_kind,subject_id,patient_id';
