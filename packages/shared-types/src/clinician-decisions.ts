import { z } from 'zod';

/**
 * Clinician result decisions (specs/006-clinician-decision-records, slice D01b).
 *
 * One entry in a result's shared decision history: a clinician's decision, an amendment of how that decision was documented, or a withdrawal of
 * an entry made in error. A decision records what the clinician intends; it is never evidence that anything was presented, ordered, dispensed
 * or taken.
 */

/**
 * Vocabulary `cdr-v1` (founder decision D6, 2026-10-28: 13 codes, data-model.md section 2.1). A code never changes once data exists: splitting or
 * renaming one is `cdr-v2`, and old entries keep `cdr-v1`. The labels below may change freely. These lists must equal the two arrays in
 * clinician_decision_codes_valid() (migration `*_clinician_result_decisions`); a test compares them.
 */
export const CDR_VOCABULARY_VERSION = 'cdr-v1' as const;
/** What kind of change (`modified` only; at least one). */
export const CDR_CHANGE_CODES = ['change-drug', 'change-dose', 'change-monitoring', 'change-other'] as const;
/** Why (at least one for `rejected`, `deferred` and `clarification-requested`; optional for `modified`; none for `accepted`). */
export const CDR_REASON_CODES = [
  'not-applicable',
  'drug-interaction',
  'clinical-context',
  'disagree-with-guideline',
  'patient-preference',
  'access',
  'information-needed',
  'report-doubt',
  'other',
] as const;
/** Codes that need a note saying what they mean. */
export const CDR_NOTE_REQUIRED_CODES = ['change-other', 'other'] as const;
export const CDR_DETAIL_CODES = [...CDR_CHANGE_CODES, ...CDR_REASON_CODES] as const;
export type CdrDetailCode = (typeof CDR_DETAIL_CODES)[number];

/** What a screen shows for each code. The one place for this wording, so no client invents its own; changing a label is not a new version. */
export const CDR_CODE_LABELS: Record<CdrDetailCode, string> = {
  'change-drug': 'Different drug',
  'change-dose': 'Different dose, frequency or duration',
  'change-monitoring': 'Added or changed monitoring',
  'change-other': 'Other change (describe in the note)',
  'not-applicable': 'Does not fit this patient',
  'drug-interaction': 'Drug interaction or phenoconversion',
  'clinical-context': 'Other clinical reason (contraindication, comorbidity, prior response)',
  'disagree-with-guideline': 'Disagree with the guideline',
  'patient-preference': 'Patient declined',
  access: 'Cost, coverage or availability',
  'information-needed': 'Needs more information first',
  'report-doubt': 'Doubt about the report itself',
  other: 'Other reason (describe in the note)',
};

/** The basis rule a write is checked against at commit (D3). */
export const CDR_ELIGIBILITY_POLICY = 'cdr-eligibility-v1' as const;

export const CDR_ENTRY_KINDS = ['decision', 'amendment', 'entered-in-error'] as const;
export const CDR_RESPONSES = ['accepted', 'modified', 'rejected', 'deferred', 'clarification-requested'] as const;
export type CdrEntryKind = (typeof CDR_ENTRY_KINDS)[number];
export type CdrResponse = (typeof CDR_RESPONSES)[number];
export const CDR_BASIS = ['active', 'retracted', 'superseded', 'quarantined', 'disputed', 'not-current'] as const;

const MAX_DETAIL_CODES = 8;
const changeCodes: readonly string[] = CDR_CHANGE_CODES;
const reasonCodes: readonly string[] = CDR_REASON_CODES;
const noteCodes: readonly string[] = CDR_NOTE_REQUIRED_CODES;

/**
 * The response decides which codes are allowed and which are required. Returns the first rule broken, or null. The database restates the same
 * rule as a CHECK, so a direct insert cannot store a combination the API refuses.
 */
export function cdrRuleViolation(entry: {
  entryKind: CdrEntryKind;
  response: CdrResponse | null;
  detailCodes: readonly string[];
  reviewBy: string | null;
  hasNote: boolean;
}): { path: string; message: string } | null {
  const { entryKind, response, detailCodes, reviewBy } = entry;
  if (entryKind === 'entered-in-error') {
    if (response !== null) return { path: 'response', message: 'A withdrawal carries no response.' };
    if (detailCodes.length > 0) return { path: 'detailCodes', message: 'A withdrawal carries no codes.' };
    if (reviewBy !== null) return { path: 'reviewBy', message: 'A withdrawal carries no review date.' };
    return null;
  }
  if (response === null) return { path: 'response', message: 'A decision or amendment needs a response.' };
  const changes = detailCodes.filter((c) => changeCodes.includes(c)).length;
  const reasons = detailCodes.filter((c) => reasonCodes.includes(c)).length;
  if (response === 'accepted' && detailCodes.length > 0) return { path: 'detailCodes', message: 'An accepted result carries no codes.' };
  if (response === 'modified' && changes === 0) return { path: 'detailCodes', message: 'A modification needs at least one change code.' };
  if (response !== 'modified' && changes > 0) return { path: 'detailCodes', message: 'Change codes go with a modification only.' };
  if ((response === 'rejected' || response === 'deferred' || response === 'clarification-requested') && reasons === 0) {
    return { path: 'detailCodes', message: 'This response needs at least one reason code.' };
  }
  if (reviewBy !== null && response !== 'deferred') return { path: 'reviewBy', message: 'A review date goes with a deferral only.' };
  if (!entry.hasNote && detailCodes.some((c) => noteCodes.includes(c))) return { path: 'note', message: 'An "other" code needs a note.' };
  return null;
}

/** `POST /evaluation-results/:resultId/clinician-decisions`. */
export const clinicianDecisionCreateSchema = z
  .strictObject({
    requestId: z.uuid(),
    evaluationId: z.uuid(),
    patientId: z.uuid(),
    entryKind: z.enum(CDR_ENTRY_KINDS),
    previousEntryId: z.uuid().nullable(),
    response: z.enum(CDR_RESPONSES).nullable().default(null),
    detailCodes: z
      .array(z.enum(CDR_DETAIL_CODES))
      .max(MAX_DETAIL_CODES)
      .default([])
      .refine((codes) => new Set(codes).size === codes.length, { message: 'A code may appear once.' }),
    reviewBy: z.iso.date().nullable().default(null),
    note: z.string().trim().min(1).max(1000).optional(),
    occurredAt: z.iso.datetime({ offset: true }).optional(),
  })
  .refine((body) => body.entryKind === 'decision' || body.previousEntryId !== null, {
    message: 'An amendment or withdrawal names the entry it follows.',
    path: ['previousEntryId'],
  })
  .superRefine((body, ctx) => {
    const broken = cdrRuleViolation({ ...body, hasNote: body.note !== undefined });
    if (broken) ctx.addIssue({ code: 'custom', message: broken.message, path: [broken.path] });
  });
export type ClinicianDecisionCreate = z.infer<typeof clinicianDecisionCreateSchema>;

/** One stored entry. The note body is never here: `{id, bodySha256}` only, the body through `GET /notes/:id`. */
export const clinicianDecisionDtoSchema = z.strictObject({
  id: z.uuid(),
  resultId: z.uuid(),
  evaluationId: z.uuid(),
  patientId: z.uuid(),
  entryKind: z.enum(CDR_ENTRY_KINDS),
  previousEntryId: z.uuid().nullable(),
  response: z.enum(CDR_RESPONSES).nullable(),
  detailCodes: z.array(z.enum(CDR_DETAIL_CODES)),
  reviewBy: z.iso.date().nullable(),
  vocabularyVersion: z.literal(CDR_VOCABULARY_VERSION),
  eligibilityPolicy: z.literal(CDR_ELIGIBILITY_POLICY),
  note: z.strictObject({ id: z.uuid(), bodySha256: z.string().regex(/^[0-9a-f]{64}$/) }).nullable(),
  occurredAt: z.iso.datetime(),
  occurredAtSource: z.enum(['recorded', 'reported']),
  createdAt: z.iso.datetime(),
  createdBy: z.string(),
  authorRoles: z.array(z.string()),
});
export type ClinicianDecisionDto = z.infer<typeof clinicianDecisionDtoSchema>;

/** `GET /evaluation-results/:resultId/clinician-decisions`: the whole history, oldest first, every author kept. */
export const clinicianDecisionHistoryDtoSchema = z.strictObject({
  resultId: z.uuid(),
  evaluationId: z.uuid(),
  patientId: z.uuid(),
  basis: z.array(z.enum(CDR_BASIS)).min(1),
  headEntryId: z.uuid().nullable(),
  currentDecisionId: z.uuid().nullable(),
  entries: z.array(clinicianDecisionDtoSchema),
  clinicalUse: z.literal('not-approved'),
  actionable: z.literal(false),
});
export type ClinicianDecisionHistoryDto = z.infer<typeof clinicianDecisionHistoryDtoSchema>;

/**
 * The current decision (data-model.md section 4): walk back from the head; an `entered-in-error` entry removes the entry it follows; the
 * current decision is the newest remaining `decision` (an amendment documents it, it is not a new one). Null when none remains.
 */
export function cdrCurrentDecisionId(entries: readonly Pick<ClinicianDecisionDto, 'id' | 'entryKind' | 'previousEntryId'>[]): string | null {
  const byId = new Map(entries.map((e) => [e.id, e]));
  const successors = new Set(entries.map((e) => e.previousEntryId).filter((id): id is string => id !== null));
  let cursor = entries.find((e) => !successors.has(e.id)) ?? null;
  while (cursor) {
    if (cursor.entryKind === 'entered-in-error') {
      const removed = cursor.previousEntryId ? byId.get(cursor.previousEntryId) : undefined;
      cursor = removed?.previousEntryId ? (byId.get(removed.previousEntryId) ?? null) : null;
      continue;
    }
    if (cursor.entryKind === 'decision') return cursor.id;
    cursor = cursor.previousEntryId ? (byId.get(cursor.previousEntryId) ?? null) : null;
  }
  return null;
}
