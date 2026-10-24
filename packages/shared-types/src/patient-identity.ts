import { z } from 'zod';

/**
 * Patient identifiers and the verified link between a report and its patient (M2.1b).
 *
 * An identifier is something the clinic already uses (a record number). The API accepts the value once, turns it into a keyed digest and
 * never shows it again: no DTO below carries a value or a digest.
 */

/** The assigning authority: a short code the organization chooses, such as `hospital-a-mrn`. */
export const identifierSystemSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$/, 'Use 1 to 40 lower-case letters, digits and hyphens, not starting or ending with a hyphen.');

export const MAX_IDENTIFIER_LENGTH = 64;

/** The value as the person types it. Normalization (white space, case) is the server's; control characters are refused. */
// eslint-disable-next-line no-control-regex -- the point is to refuse control characters
const NO_CONTROL = /^[^\u0000-\u001f\u007f]+$/;
export const identifierValueSchema = z
  .string()
  .trim()
  .min(1, 'Enter the identifier exactly as it is written.')
  .max(MAX_IDENTIFIER_LENGTH, `Use ${MAX_IDENTIFIER_LENGTH} characters or fewer.`)
  .regex(NO_CONTROL, 'Use printable characters only.');

/** `POST /patients/:id/identifiers`. */
export const identifierCreateSchema = z.strictObject({
  system: identifierSystemSchema,
  value: identifierValueSchema,
  /** Retry identity for this person in this organization. A repeat with the same id and the same body replays the identifier; without one nothing is replayed. */
  requestId: z.uuid().transform((value) => value.toLowerCase()).optional(),
});
export type IdentifierCreate = z.infer<typeof identifierCreateSchema>;

/** `/patients/:id/identifiers/:identifierId` */
export const identifierParamSchema = z.strictObject({ id: z.uuid(), identifierId: z.uuid() });
export type IdentifierParam = z.infer<typeof identifierParamSchema>;

/** What the API shows of an identifier: which authority and when, never the value. */
export const identifierDtoSchema = z.strictObject({
  id: z.uuid(),
  patientId: z.uuid(),
  system: z.string(),
  status: z.enum(['active', 'withdrawn']),
  createdAt: z.iso.datetime(),
  withdrawnAt: z.iso.datetime().nullable(),
});
export type IdentifierDto = z.infer<typeof identifierDtoSchema>;

// ---------------------------------------------------------------------------------------------------------------- the report's link

export const LINK_VERIFY_BASIS_CODES = ['no-identifier-on-report', 'identifier-not-registered', 'documented-clinic-procedure'] as const;
export const LINK_REJECT_BASIS_CODES = ['different-person', 'identifier-conflict', 'cannot-establish'] as const;
export type LinkVerifyBasisCode = (typeof LINK_VERIFY_BASIS_CODES)[number];
export type LinkRejectBasisCode = (typeof LINK_REJECT_BASIS_CODES)[number];

/**
 * `POST /reports/:id/patient-link/decisions`. Three shapes:
 *  - verify by matching an identifier the person read off the report (the value is digested on arrival and kept nowhere);
 *  - verify by the person's own attestation, with a coded reason (the weaker method, shown as such);
 *  - reject the link, with a coded reason.
 */
export const patientLinkDecisionCreateSchema = z.discriminatedUnion('method', [
  z.strictObject({ method: z.literal('identifier-match'), decision: z.literal('verified'), system: identifierSystemSchema, value: identifierValueSchema }),
  z.strictObject({
    method: z.literal('person-confirmed'),
    decision: z.enum(['verified', 'rejected']),
    basisCode: z.enum([...LINK_VERIFY_BASIS_CODES, ...LINK_REJECT_BASIS_CODES]),
  }),
]).refine(
  (body) => body.method === 'identifier-match' || (body.decision === 'verified' ? (LINK_VERIFY_BASIS_CODES as readonly string[]) : (LINK_REJECT_BASIS_CODES as readonly string[])).includes(body.basisCode),
  { message: 'That reason does not go with that decision.', path: ['basisCode'] },
);
export type PatientLinkDecisionCreate = z.infer<typeof patientLinkDecisionCreateSchema>;

export const patientLinkDecisionDtoSchema = z.strictObject({
  id: z.uuid(),
  decision: z.enum(['verified', 'rejected']),
  method: z.enum(['identifier-match', 'person-confirmed']),
  basisCode: z.string().nullable(),
  createdAt: z.string(),
});
export type PatientLinkDecisionDto = z.infer<typeof patientLinkDecisionDtoSchema>;

/**
 * Where a report's link to its patient stands for the file it holds NOW. `unverified` also covers "decided for an earlier file":
 * then `staleDecision` is true and `decision` is the earlier one.
 */
export const patientLinkDtoSchema = z.strictObject({
  reportId: z.uuid(),
  patientId: z.uuid(),
  state: z.enum(['unverified', 'verified', 'rejected']),
  decision: patientLinkDecisionDtoSchema.nullable(),
  staleDecision: z.boolean(),
});
export type PatientLinkDto = z.infer<typeof patientLinkDtoSchema>;
