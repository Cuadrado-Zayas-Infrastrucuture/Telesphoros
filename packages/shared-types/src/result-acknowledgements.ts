import { z } from 'zod';
import { CDR_BASIS } from './clinician-decisions';

/**
 * Result acknowledgements (specs/019-presentation-events, slice D02a).
 *
 * One acknowledgement says that a clinician reviewed one result row in the basis it was shown with, for one review task. It records that a review
 * was made, not what it concluded (spec 006 decisions do that), and never that anything was read, ordered, dispensed or taken. A result row is
 * immutable, so the row is the result version (A2); the basis is the spec 006 basis of that row, computed by the same SQL.
 */

/** A3: `review` on any basis without `retracted`; `retraction-reviewed` only on one with it. Never a generic acknowledgement of a retracted result. */
export const ACK_KINDS = ['review', 'retraction-reviewed'] as const;
export type AckKind = (typeof ACK_KINDS)[number];
/** A5: a closed vocabulary. `result-review` is the only review task in v1; a new task is a new value, never a reuse. */
export const ACK_REVIEW_TASKS = ['result-review'] as const;
export type AckReviewTask = (typeof ACK_REVIEW_TASKS)[number];
/** The meaning of the stored basis categories: the spec 006 basis (CDR_BASIS) in the order the server reports it. */
export const ACK_BASIS_RULE = 'cdr-basis-v1' as const;
export type AckBasis = (typeof CDR_BASIS)[number];

/** The `reason` of each refusal a client must tell apart (in `error.details[0].reason`). */
export const ACK_REFUSAL_REASONS = {
  /** A4: the server's basis at commit is not the one the client displayed. Read the result again; nothing was stored. */
  basisChanged: 'acknowledgement-basis-changed',
  /** A5: this clinician already acknowledged this result for this task and kind (with another request id). */
  alreadyAcknowledged: 'already-acknowledged',
  /** The request id was used before with different fields. */
  requestIdReused: 'request-id-reused',
  /** The result or patient named does not match the result in the path. */
  bindingMismatch: 'acknowledgement-binding-mismatch',
} as const;

const basisOrder: readonly string[] = CDR_BASIS;
/** The basis in the order the server reports it, so two equal sets compare (and hash) equal. */
export function canonicalAckBasis(basis: readonly AckBasis[]): AckBasis[] {
  return [...basis].sort((a, b) => basisOrder.indexOf(a) - basisOrder.indexOf(b));
}
/** The one kind a basis allows (A3). */
export function ackKindFor(basis: readonly AckBasis[]): AckKind {
  return basis.includes('retracted') ? 'retraction-reviewed' : 'review';
}
/** Same categories, regardless of order. */
export function sameAckBasis(a: readonly AckBasis[], b: readonly AckBasis[]): boolean {
  const x = canonicalAckBasis(a);
  const y = canonicalAckBasis(b);
  return x.length === y.length && x.every((value, index) => value === y[index]);
}

const ackBasisSchema = z
  .array(z.enum(CDR_BASIS))
  .min(1)
  .max(CDR_BASIS.length)
  .refine((basis) => new Set(basis).size === basis.length, { message: 'A basis category may appear once.' })
  .refine((basis) => !basis.includes('active') || basis.length === 1, { message: '`active` stands alone.' });

/** `POST /evaluation-results/:resultId/acknowledgements`. Every field is the client's: what it displayed and what it asks to record. */
export const resultAcknowledgementCreateSchema = z
  .strictObject({
    requestId: z.uuid(),
    /** The result row reviewed; must be the one in the path. */
    resultId: z.uuid(),
    /** The patient the client displayed the result for; must be the result's. */
    patientId: z.uuid(),
    kind: z.enum(ACK_KINDS),
    reviewTask: z.enum(ACK_REVIEW_TASKS),
    /** The basis the client displayed (A4). Compared with the server's at commit. */
    displayedBasis: ackBasisSchema.transform(canonicalAckBasis),
  })
  .refine((body) => body.kind === ackKindFor(body.displayedBasis), {
    message: 'A retracted result takes "retraction-reviewed", and only a retracted one does.',
    path: ['kind'],
  });
export type ResultAcknowledgementCreate = z.infer<typeof resultAcknowledgementCreateSchema>;
export type ResultAcknowledgementCreateInput = z.input<typeof resultAcknowledgementCreateSchema>;

/** One stored acknowledgement, with the basis it was made in. */
export const resultAcknowledgementDtoSchema = z.strictObject({
  id: z.uuid(),
  resultId: z.uuid(),
  evaluationId: z.uuid(),
  patientId: z.uuid(),
  kind: z.enum(ACK_KINDS),
  reviewTask: z.enum(ACK_REVIEW_TASKS),
  basis: ackBasisSchema,
  basisRule: z.literal(ACK_BASIS_RULE),
  createdAt: z.iso.datetime(),
  createdBy: z.string(),
  authorRoles: z.array(z.string()),
});
export type ResultAcknowledgementDto = z.infer<typeof resultAcknowledgementDtoSchema>;

/**
 * `GET /evaluation-results/:resultId/acknowledgements` (A1): every acknowledgement of the result, oldest first, every author kept, with the basis now.
 * `basisIsCurrent` is false for one made in a basis that has since changed (for example a review made before a retraction): it is historical.
 * `byYou` marks the caller's own, so a client can show its own review without knowing its subject id.
 */
export const resultAcknowledgementsDtoSchema = z.strictObject({
  resultId: z.uuid(),
  evaluationId: z.uuid(),
  patientId: z.uuid(),
  basis: ackBasisSchema,
  acknowledgements: z.array(resultAcknowledgementDtoSchema.extend({ basisIsCurrent: z.boolean(), byYou: z.boolean() })),
  clinicalUse: z.literal('not-approved'),
  actionable: z.literal(false),
});
export type ResultAcknowledgementsDto = z.infer<typeof resultAcknowledgementsDtoSchema>;
