import { z } from 'zod';
const uuid = z.uuid().transform((value) => value.toLowerCase());
const date = z.iso.date();
const timezone = z
  .string()
  .min(1)
  .max(100)
  .refine((value) => {
    try {
      new Intl.DateTimeFormat('en', { timeZone: value });
      return true;
    } catch {
      return false;
    }
  }, 'Choose a recognized timezone.');
export const followupAssessmentSchema = z.strictObject({
  date,
  timezone,
  response: z.enum(['improved', 'unchanged', 'worsened', 'not-assessed']),
  symptoms: z.enum(['reported', 'none-reported', 'not-assessed']),
  adherence: z.enum(['taking-reported', 'not-taking-reported', 'not-assessed']),
  source: z.enum(['clinician-assessed', 'patient-reported']),
});
export const followupNextSchema = z.strictObject({
  date,
  timezone,
  assignee: z.string().min(1).max(128),
});
export const followupInputSchema = z
  .strictObject({
    requestId: uuid,
    threadId: uuid.optional(),
    expectedVersion: z.int().min(1).max(1_000_000).optional(),
    action: z.enum(['schedule', 'document', 'amend', 'reschedule', 'dismiss']),
    medicationId: uuid,
    decisionId: uuid.nullable(),
    assessment: followupAssessmentSchema.nullable(),
    note: z.string().trim().min(1).max(1000),
    next: followupNextSchema.nullable(),
  })
  .superRefine((input, ctx) => {
    const issue = (path: string, message: string) => ctx.addIssue({ code: 'custom', path: [path], message });
    if (Boolean(input.threadId) !== (input.expectedVersion !== undefined)) issue('threadId', 'An existing thread needs its current version.');
    if (['amend', 'reschedule', 'dismiss'].includes(input.action) && !input.threadId) issue('threadId', 'Choose an existing follow-up.');
    if (input.action === 'schedule' && input.threadId) issue('action', 'Use reschedule for an existing follow-up.');
    if (['document', 'amend'].includes(input.action) !== (input.assessment !== null)) issue('assessment', 'Document or amend an assessment explicitly.');
    if (['schedule', 'reschedule'].includes(input.action) && !input.next) issue('next', 'Choose the next date and responsible clinician.');
    if (input.action === 'dismiss' && input.next) issue('next', 'A dismissed reminder has no next date.');
    if (input.assessment && input.next && input.next.date < input.assessment.date) issue('next', 'The next date cannot precede this assessment.');
  });
export type FollowupInput = z.infer<typeof followupInputSchema>;
export const followupDtoSchema = z.strictObject({
  id: uuid,
  threadId: uuid,
  patientId: uuid,
  patientLabel: z.string(),
  medicationId: uuid,
  medicationName: z.string(),
  decisionId: uuid.nullable(),
  version: z.int().min(1),
  action: z.enum(['schedule', 'document', 'amend', 'reschedule', 'dismiss']),
  assessment: followupAssessmentSchema.nullable(),
  note: z.string(),
  noteRedacted: z.boolean(),
  next: followupNextSchema.nullable(),
  createdAt: z.iso.datetime(),
  createdBy: z.string(),
  current: z.boolean(),
  dueState: z.enum(['closed', 'overdue', 'today', 'upcoming']),
  needsReassignment: z.boolean(),
});
export type FollowupDto = z.infer<typeof followupDtoSchema>;
export const followupQuerySchema = z.strictObject({
  threadId: uuid.optional(),
  page: z.coerce.number().int().min(1).max(100_000).default(1),
});
export type FollowupQuery = z.infer<typeof followupQuerySchema>;
export const followupInboxFiltersSchema = z.strictObject({
  assignment: z.enum(['all', 'mine']).default('all'),
  status: z.enum(['all', 'overdue', 'today', 'upcoming', 'reassignment']).default('all'),
});
export type FollowupInboxFilters = z.infer<typeof followupInboxFiltersSchema>;
export const followupInboxQuerySchema = followupQuerySchema
  .extend(followupInboxFiltersSchema.shape)
  .refine((query) => !query.threadId || (query.assignment === 'all' && query.status === 'all'), 'History selection cannot be combined with inbox filters.');
export type FollowupInboxQuery = z.infer<typeof followupInboxQuerySchema>;
export const followupListSchema = z.strictObject({
  currentActor: z.string(),
  items: z.array(followupDtoSchema),
  page: z.int().min(1),
  hasMore: z.boolean(),
  counts: z.strictObject({ overdue: z.int().min(0), today: z.int().min(0), upcoming: z.int().min(0), unassigned: z.int().min(0) }),
});
export type FollowupList = z.infer<typeof followupListSchema>;
export const followupAssigneesSchema = z.strictObject({ currentActor: z.string(), items: z.array(z.string()) });
export const followupSummaryQuerySchema = z.strictObject({});
export const followupResponseSummarySchema = z
  .strictObject({
    definition: z.literal('followup-response-v1'),
    asOf: z.iso.datetime(),
    total: z.int().min(0),
    responses: z.strictObject({
      improved: z.int().min(0),
      unchanged: z.int().min(0),
      worsened: z.int().min(0),
      notAssessed: z.int().min(0),
      noAssessment: z.int().min(0),
    }),
  })
  .refine((value) => Object.values(value.responses).reduce((sum, count) => sum + count, 0) === value.total, 'Response counts must equal the follow-up total.');
export type FollowupResponseSummary = z.infer<typeof followupResponseSummarySchema>;
