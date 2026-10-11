import type { CorrectionHistory } from "./correction-history.js";
import { z } from "zod";
import { pgxVersionsSchema, type PgxFhirBundle } from "./pgx-fhir.js";
export const storedPatientSchema = z.strictObject({
  patientId: z.uuid(), label: z.string().regex(/^SYN-[A-Za-z0-9-]{1,36}$/), evaluationId: z.uuid(),
});
export type StoredPatient = z.infer<typeof storedPatientSchema>;
export const registrationSchema = z.object({
  tenantId: z.literal("synthetic-office"),
  clientId: z.string().min(1),
  issuer: z.string(),
  authorizationEndpoint: z.string(),
  tokenEndpoint: z.string(),
  jwksUri: z.string(),
  oidcIssuer: z.string(),
  patients: z
    .array(
      z.object({
        fhirId: z.string(),
        patientId: z.string(),
        syntheticIdentifier: z.string().optional(),
        pgx: pgxVersionsSchema.optional(),
        stored: storedPatientSchema.optional(),
        consent: z.boolean(),
        interpretable: z.boolean(),
        profile: z
          .array(z.object({ gene: z.string(), result: z.string() }))
          .optional(),
      }),
    )
    .min(1),
});
export type Registration = z.infer<typeof registrationSchema>;
export interface Flow {
  registration: Registration;
  verifier: string;
  nonce: string;
  browser: string;
  redirectUri: string;
  expires: number;
}
export interface Context {
  token: string;
  patient: string;
  encounter: string | null;
  user: string;
  expires: number;
}
export type Session = Context & { registration: Registration };
export interface Diagnostic {
  stage: "callback" | "evidence";
  code: string;
  status: number | null;
}
export interface Medication {
  requestId: string | null;
  drug: string | null;
  rxcui: string | null;
}
export interface Evidence {
  synthetic: true;
  clinicalRecommendationsEnabled: false;
  status: string;
  patient: string;
  encounter: string | null;
  clinician: string;
  tenant: string;
  expiresAt: string;
  freshUntil: string;
  correctionHistory: CorrectionHistory | null;
  medications: Medication[];
  pagesRead: number;
  uncertainMedicationCount: number;
  unmappedMedicationCount: number;
  profile: { gene: string; result: string }[];
  evidenceSource: "static-synthetic" | "stored-synthetic";
  pgxFhirPreview: PgxFhirBundle | null;
  evidence: string;
}
export const patientSchema = z.object({
  resourceType: z.literal("Patient"),
  id: z.string(),
  meta: z
    .object({
      tag: z
        .array(
          z.object({
            system: z.string().optional(),
            code: z.string().optional(),
          }),
        )
        .optional(),
    })
    .optional(),
  identifier: z
    .array(
      z.object({ system: z.string().optional(), value: z.string().optional() }),
    )
    .optional(),
});
export const medicationSchema = z.object({
  resourceType: z.literal("MedicationRequest"),
  id: z.string().optional(),
  status: z.string().optional(),
  subject: z.object({ reference: z.string() }),
  medicationCodeableConcept: z
    .object({
      text: z.string().optional(),
      coding: z
        .array(
          z.object({
            system: z.string().optional(),
            code: z.string().optional(),
            display: z.string().optional(),
          }),
        )
        .optional(),
    })
    .optional(),
});
export const bundleSchema = z.object({
  resourceType: z.literal("Bundle"),
  type: z.enum(["searchset", "collection"]),
  entry: z.array(z.object({ resource: medicationSchema })).optional(),
  link: z.array(z.object({ relation: z.string(), url: z.string() })).optional(),
});
export const tokenSchema = z.object({
  access_token: z.string().min(1).max(16384),
  token_type: z.string(),
  expires_in: z.number().positive(),
  scope: z.string(),
  patient: z.string(),
  encounter: z.string().optional(),
  id_token: z.string().max(32768),
});
