import { z } from "zod";
import jwt from "jsonwebtoken";
import {
  evaluationDtoSchema, patientDtoSchema, reportDtoSchema, captureDtoSchema,
  tenantIdSchema, tenantFromGroups, PIPELINE_SCOPE,
} from "@telesphoros/shared-types";
import { correctionHistory } from "./correction-history.js";
import { readSourcePdf } from "./source-pdf.js";
import { buildPgxCollection, type FhirBinding } from "./pgx-fhir.js";
import { fail, loopbackUrl, requestJson } from "./client.js";

import { storedPatientSchema, type StoredPatient } from "./types.js";
const configSchema = z.strictObject({
  mode: z.literal("stored-synthetic"), apiBaseUrl: z.string(), issuer: z.string(), clientId: z.string().min(1),
  sourcePdf: z.strictObject({ storageOrigin: z.string() }).optional(),
  readers: z.array(z.strictObject({
    ehrIssuer: z.string(),
    clinician: z.string().regex(/^Practitioner(Role)?\/[A-Za-z0-9.-]{1,64}$/),
    subject: z.string().min(1).max(128), tenantId: tenantIdSchema,
    token: z.string().min(1).max(16384),
  })).min(1).max(20),
});
const completeGenes = z.array(z.strictObject({
  gene: z.string().regex(/^[A-Z][A-Z0-9]{0,19}$/),
  state: z.literal("canonical"), phenotype: z.string().min(1).max(120),
  diplotype: z.string().min(1).max(120).nullable(), activityScore: z.string().nullable(), reasonCode: z.null(),
})).min(1).max(50).refine(genes => new Set(genes.map(g => g.gene)).size === genes.length);

export function createStoredPgxReader(value: unknown, now = Date.now) {
  if (process.env.NODE_ENV === "production") fail("synthetic_only");
  const config = configSchema.parse(value);
  const base = loopbackUrl(config.apiBaseUrl);
  const issuer = loopbackUrl(config.issuer);
  if (base.pathname !== "/api/v1" || base.search || issuer.search)
    fail("invalid_stored_endpoint");
  if (config.sourcePdf && loopbackUrl(config.sourcePdf.storageOrigin).origin !== config.sourcePdf.storageOrigin)
    fail("invalid_storage_origin");
  for (const r of config.readers) {
    const ehr = loopbackUrl(r.ehrIssuer);
    if (ehr.search || ehr.pathname.endsWith("/")) fail("invalid_stored_endpoint");
  }
  if (new Set(config.readers.map(r => JSON.stringify([r.ehrIssuer, r.clinician]))).size !== config.readers.length)
    fail("ambiguous_stored_reader");
  return async (selection: StoredPatient, clinician: string, binding: FhirBinding) => {
    const selected = storedPatientSchema.parse(selection);
    const reader = config.readers.find(r => r.clinician === clinician && r.ehrIssuer === binding.issuer);
    if (!reader) fail("stored_reader_unavailable");
    const get = (path: string) => requestJson(`${base.href}${path}`, { token: reader.token });
    // /me verifies this exact bearer using the API's existing signature/issuer/role guard.
    // Decoding below ONLY pins that authenticated token to the configured principal; it is not signature verification.
    const me = z.object({ roles: z.array(z.string()) }).parse(await get("/me"));
    const claims = z.object({ sub: z.string(), iss: z.string(), client_id: z.string(), token_use: z.literal("access"),
      exp: z.number().int(), "cognito:groups": z.array(z.string()),
    }).parse(jwt.decode(reader.token));
    const tenant = tenantFromGroups(claims["cognito:groups"]);
    if (claims.sub !== reader.subject || claims.iss !== config.issuer || claims.client_id !== config.clientId ||
        !tenant.ok || tenant.tenantId !== reader.tenantId ||
        !me.roles.some(role => ["clinician", "reviewer"].includes(role)) || claims.exp * 1000 <= now())
      fail("stored_principal_mismatch");
    const patient = patientDtoSchema.parse(await get(`/patients/${selected.patientId}`));
    const evaluation = evaluationDtoSchema.parse(await get(`/evaluations/${selected.evaluationId}`));
    if (patient.id !== selected.patientId || patient.label !== selected.label || evaluation.id !== selected.evaluationId ||
        evaluation.patientId !== patient.id || evaluation.scope !== PIPELINE_SCOPE || evaluation.clinicalUse !== "not-approved" ||
        evaluation.actionable !== false || !evaluation.engineVersion || !evaluation.knowledgeSetId) fail("stored_evaluation_withheld");
    const history = correctionHistory(evaluation);
    const report = reportDtoSchema.parse(await get(`/reports/${evaluation.reportId}`));
    const capture = captureDtoSchema.parse(await get(`/captures/${evaluation.captureId}`));
    if (report.id !== evaluation.reportId || report.patientId !== patient.id || report.type !== "lab-pdf" ||
        !report.fileUploaded || report.contentType !== "application/pdf" || !report.sha256 ||
        capture.id !== evaluation.captureId || capture.reportId !== report.id || capture.pdfSha256 !== report.sha256)
      fail("stored_source_mismatch");
    // History can explain an unavailable selection, but every existing gate still controls genomic/PDF content.
    const eligible = evaluation.current && evaluation.state === "active" && evaluation.supersededBy === null &&
      evaluation.disposition === "evaluated" && evaluation.holdCode === null && evaluation.hold === null &&
      evaluation.advisory.activeDisputes === 0 && evaluation.advisory.patientLink === "verified" && evaluation.acceptance?.current === true && evaluation.acceptance.decision === "accepted" &&
      capture.latestDecision?.id === evaluation.acceptance.id && capture.latestDecision.decision === "accepted" &&
      capture.latestDecision.captureId === capture.id && capture.latestDecision.textSha256 === capture.textSha256 &&
      capture.latestDecision.popplerVersion === capture.popplerVersion;
    const genes = eligible ? completeGenes.parse(evaluation.geneStates) : [];
    const pdf = eligible && config.sourcePdf ? await readSourcePdf(await get(`/reports/${report.id}/download-url`),
      config.sourcePdf.storageOrigin, { sizeBytes: report.sizeBytes, sha256: capture.pdfSha256 }, now) : null;
    // Closing reads catch changes during assembly. This is a bounded read, not an atomic DB snapshot or ongoing correction feed.
    for (const [path, schema, before] of [
      [`/patients/${patient.id}`, patientDtoSchema, patient],
      [`/reports/${report.id}`, reportDtoSchema, report],
      [`/captures/${capture.id}`, captureDtoSchema, capture],
      [`/evaluations/${evaluation.id}`, evaluationDtoSchema, evaluation],
    ] as const) {
      if (JSON.stringify(schema.parse(await get(path))) !== JSON.stringify(before)) fail("stored_context_changed");
    }
    const expires = Math.min(claims.exp * 1000, pdf?.expires ?? Infinity);
    if (expires <= now()) fail("stored_token_expired");
    if (!eligible) return { bundle: null, expires, profile: [], history };
    const snapshot = {
      correctionRevision: history.revision,
      evaluationId: evaluation.id, captureId: capture.id, createdAt: evaluation.createdAt,
      engineVersion: evaluation.engineVersion, knowledgeSetId: evaluation.knowledgeSetId,
      acceptance: { id: evaluation.acceptance!.id },
      genes: genes.map(g => ({ gene: g.gene, diplotype: g.diplotype, phenotype: g.phenotype })),
    };
    return {
      bundle: buildPgxCollection(snapshot, { ...binding, tenantId: reader.tenantId, patientId: patient.id },
        pdf ? { kind: "stored-pdf", reportId: report.id, versionId: pdf.versionId, sha256: pdf.sha256, data: pdf.data, size: pdf.size }
          : { kind: "stored-reference", reportId: report.id, sha256: capture.pdfSha256 }),
      expires, history,
      profile: snapshot.genes.map(g => ({ gene: g.gene, result: `Synthetic stored result: ${g.phenotype}` })),
    };
  };
}
export type StoredPgxReader = ReturnType<typeof createStoredPgxReader>;
