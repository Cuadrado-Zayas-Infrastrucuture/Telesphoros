import { z } from 'zod';

/** Draft spec 032/S1 interchange only. No route, clinical engine or trust decision consumes this contract. */
export const SYNTHETIC_PGX_SCHEMA_VERSION = 'pgx-synthetic-0.1' as const;
export const SYNTHETIC_PGX_MAX_BYTES = 256 * 1024;
const id = z.string().regex(/^syn-[a-z0-9-]{1,76}$/);
const label = z
  .string()
  .min(1)
  .max(100)
  .refine((s) => s.trim().length > 0, 'A value cannot be blank.');
const text = z
  .string()
  .min(1)
  .max(500)
  .refine((s) => s.trim().length > 0, 'A value cannot be blank.');
const instant = z.iso.datetime({ offset: true });
const version = z.int().min(1).max(1_000_000);
const limitations = z.array(text).min(1).max(20);
const gene = z.enum(['GENEA', 'GENEB', 'GENEC', 'GENED']);
const ids = z
  .array(id)
  .max(100)
  .refine((v) => new Set(v).size === v.length, 'Duplicate reference.');
const before = (a: string, b: string) => Date.parse(a) < Date.parse(b);
const issue = (ctx: z.RefinementCtx, path: (string | number)[], message: string) => ctx.addIssue({ code: 'custom', path, message });
const unique = (values: { id: string }[], ctx: z.RefinementCtx, path: (string | number)[]) => {
  if (new Set(values.map((v) => v.id)).size !== values.length) issue(ctx, path, 'Duplicate record ID.');
};

/** Typed evidence, not a genotype caller. Original text is never normalized or replaced. */
export const syntheticPgxCallSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('diplotype'), originalText: text, value: label, phase: z.literal('resolved'), copyNumber: z.int().min(1).max(20).nullable() }),
  z.strictObject({ kind: z.literal('allele'), originalText: text, value: label, nomenclatureVersion: label }),
  z.strictObject({ kind: z.literal('variant'), originalText: text, reference: label, hgvs: label, zygosity: label }),
  z.strictObject({ kind: z.literal('activity'), originalText: text, value: z.number().min(0).max(1_000_000), unit: label, method: label, measuredAt: instant }),
  z.strictObject({
    kind: z.literal('unresolved'),
    originalText: text,
    candidates: z
      .array(label)
      .min(1)
      .max(20)
      .refine((v) => new Set(v).size === v.length, 'Duplicate candidate.'),
  }),
]);

export const syntheticPgxManifestSchema = z
  .strictObject({
    id,
    version: label,
    laboratoryId: id,
    method: text,
    specimenTypes: z.array(label).min(1).max(10),
    referenceAssembly: label,
    nomenclatureVersion: label,
    targets: z
      .array(
        z.strictObject({
          id,
          gene,
          variantClasses: z
            .array(z.enum(['sequence', 'copy-number', 'repeat', 'activity']))
            .min(1)
            .max(4),
          alleles: z.array(label).max(100),
          limitations,
        }),
      )
      .min(1)
      .max(100),
    limitations,
  })
  .superRefine((value, ctx) => unique(value.targets, ctx, ['targets']));

export const syntheticPgxFindingSchema = z
  .strictObject({
    id,
    targetId: id,
    gene,
    orderScope: z.enum(['ordered', 'not-ordered', 'unknown']),
    coverage: z.enum(['tested', 'not-tested', 'outside-coverage', 'unknown']),
    analyticalState: z.enum(['resolved', 'no-call', 'ambiguous', 'not-applicable']),
    interpretationState: z.enum(['interpretable', 'indeterminate', 'conflicting', 'unsupported-definition', 'not-assessed']),
    reportedCall: syntheticPgxCallSchema.nullable(),
    laboratoryInterpretation: z.strictObject({ phenotype: label.nullable(), activityScore: z.number().min(0).max(100).nullable(), translationVersion: label }).nullable(),
    limitations,
  })
  .superRefine((f, ctx) => {
    if (['not-tested', 'outside-coverage'].includes(f.coverage) && f.analyticalState !== 'not-applicable')
      issue(ctx, ['analyticalState'], 'Untested targets have no analytical result.');
    if (f.coverage === 'tested' && f.analyticalState === 'not-applicable') issue(ctx, ['analyticalState'], 'A tested target needs an explicit analytical result.');
    if (f.analyticalState === 'resolved' && (!f.reportedCall || f.reportedCall.kind === 'unresolved')) issue(ctx, ['reportedCall'], 'Resolved findings require a resolved call.');
    if (f.analyticalState === 'ambiguous' && (f.reportedCall?.kind !== 'unresolved' || f.laboratoryInterpretation !== null))
      issue(ctx, ['reportedCall'], 'Ambiguity needs explicit candidates, not an interpretation.');
    if (['no-call', 'not-applicable'].includes(f.analyticalState) && (f.reportedCall !== null || f.laboratoryInterpretation !== null))
      issue(ctx, ['reportedCall'], 'No result cannot contain an inferred call or interpretation.');
    if (f.analyticalState !== 'resolved' && f.interpretationState === 'interpretable') issue(ctx, ['interpretationState'], 'An unresolved result is not interpretable.');
    if (f.laboratoryInterpretation && f.laboratoryInterpretation.phenotype === null && f.laboratoryInterpretation.activityScore === null)
      issue(ctx, ['laboratoryInterpretation'], 'An empty interpretation must be null.');
  });

export const syntheticPgxLabReportSchema = z
  .strictObject({
    id,
    seriesId: id,
    revision: version,
    previousRevisionId: id.nullable(),
    status: z.enum(['preliminary', 'final', 'amended', 'corrected', 'cancelled', 'entered-in-error']),
    patientId: id,
    laboratoryId: id,
    accession: id,
    specimen: z.strictObject({ id, type: label, collectedAt: instant }),
    issuedAt: instant,
    receivedAt: instant,
    releasedBy: label,
    assay: z.discriminatedUnion('state', [
      z.strictObject({ state: z.literal('provided'), manifest: syntheticPgxManifestSchema }),
      z.strictObject({ state: z.literal('unavailable'), reason: text }),
    ]),
    findings: z.array(syntheticPgxFindingSchema).max(50),
    limitations,
  })
  .superRefine((r, ctx) => {
    unique(r.findings, ctx, ['findings']);
    if (new Set(r.findings.map((f) => f.targetId)).size !== r.findings.length)
      issue(ctx, ['findings'], 'This prototype requires one finding per target; reconcile repeats explicitly.');
    if ((r.revision === 1) !== (r.previousRevisionId === null) || r.previousRevisionId === r.id)
      issue(ctx, ['previousRevisionId'], 'A later revision needs a different predecessor; a first revision has none.');
    if (['amended', 'corrected'].includes(r.status) && r.revision === 1) issue(ctx, ['revision'], 'An amendment/correction needs a prior revision.');
    if (before(r.issuedAt, r.specimen.collectedAt) || before(r.receivedAt, r.issuedAt)) issue(ctx, ['issuedAt'], 'Collection, issue and receipt must be ordered.');
    if (r.assay.state === 'provided') {
      const manifest = r.assay.manifest;
      if (manifest.laboratoryId !== r.laboratoryId) issue(ctx, ['assay'], 'Manifest laboratory differs from report issuer.');
      if (!manifest.specimenTypes.includes(r.specimen.type)) issue(ctx, ['specimen'], 'Specimen is outside the manifest.');
      r.findings.forEach((f, i) => {
        const target = manifest.targets.find((t) => t.id === f.targetId);
        if (!target || target.gene !== f.gene) issue(ctx, ['findings', i, 'targetId'], 'Finding must reference its manifest gene/target.');
        const call = f.reportedCall;
        if (call?.kind === 'activity' && (!target?.variantClasses.includes('activity') || before(call.measuredAt, r.specimen.collectedAt) || before(r.issuedAt, call.measuredAt)))
          issue(ctx, ['findings', i, 'reportedCall'], 'Activity requires declared method coverage and measurement between collection and issue.');
        if (call?.kind === 'variant' && !target?.variantClasses.includes('sequence')) issue(ctx, ['findings', i, 'reportedCall'], 'Variant requires declared sequence coverage.');
        if (call?.kind === 'diplotype' && call.copyNumber !== null && call.copyNumber > 2 && !target?.variantClasses.includes('copy-number'))
          issue(ctx, ['findings', i, 'reportedCall'], 'Extra copies require declared copy-number coverage.');
      });
    } else if (r.findings.some((f) => f.coverage !== 'unknown')) issue(ctx, ['findings'], 'Unavailable manifest requires unknown coverage in this prototype.');
  });

const medication = z
  .strictObject({
    id,
    version,
    drug: label,
    route: label.nullable(),
    indication: label.nullable(),
    status: z.enum(['active', 'stopped', 'unknown']),
    startAt: instant.nullable(),
    stopAt: instant.nullable(),
    verifiedAt: instant.nullable(),
  })
  .superRefine((m, ctx) => {
    if (m.startAt && m.stopAt && before(m.stopAt, m.startAt)) issue(ctx, ['stopAt'], 'Stop precedes start.');
    if (m.status === 'active' && m.stopAt) issue(ctx, ['stopAt'], 'Active medication cannot carry a stop time.');
  });
const context = z.strictObject({ id, patientId: id, version, effectiveAt: instant, recordedAt: instant, medications: z.array(medication).max(50) }).superRefine((c, ctx) => {
  unique(c.medications, ctx, ['medications']);
  if (before(c.recordedAt, c.effectiveAt)) issue(ctx, ['recordedAt'], 'Recorded time precedes context effective time.');
  c.medications.forEach((m, i) => {
    if (m.verifiedAt && before(c.recordedAt, m.verifiedAt)) issue(ctx, ['medications', i, 'verifiedAt'], 'Verification is after this snapshot.');
  });
});
const rule = z.strictObject({
  id,
  version: label,
  cell: label,
  drug: label,
  route: label,
  indication: label,
  requiredTargetIds: ids.refine((v) => v.length > 0, 'A rule needs required targets.'),
});
const knowledge = z
  .strictObject({ id, version: label, source: z.literal('synthetic-example'), translationVersion: label, softwareVersion: label, rules: z.array(rule).max(50) })
  .superRefine((k, ctx) => unique(k.rules, ctx, ['rules']));
const supported = (disposition: string) => disposition === 'applicable' || disposition === 'standard-prescribing';
export const syntheticPgxResultSchema = z
  .strictObject({
    id,
    medicationId: id,
    drug: label,
    disposition: z.enum(['applicable', 'standard-prescribing', 'no-recommendation', 'missing-prerequisites', 'outside-scope', 'retired', 'held-conflict']),
    findingIds: ids,
    missingPrerequisites: z.array(text).max(20),
    sourceRuleId: id.nullable(),
    recommendationText: text.nullable(),
    reason: text,
  })
  .superRefine((r, ctx) => {
    if (supported(r.disposition)) {
      if (!r.recommendationText || !r.sourceRuleId || r.findingIds.length === 0 || r.missingPrerequisites.length > 0)
        issue(ctx, ['disposition'], 'A supported result needs complete evidence, a rule and wording.');
    } else if (r.recommendationText !== null) issue(ctx, ['recommendationText'], 'Unresolved or unsupported results cannot expose recommendation wording.');
    if (r.disposition === 'missing-prerequisites' && r.missingPrerequisites.length === 0) issue(ctx, ['missingPrerequisites'], 'Name the missing prerequisites.');
  });
export const syntheticPgxAssessmentSchema = z
  .strictObject({
    id,
    previousAssessmentId: id.nullable(),
    status: z.enum(['draft', 'released', 'superseded', 'retracted']),
    sourceReport: z.strictObject({ id, revision: version, patientId: id }),
    generatedAt: instant,
    context,
    knowledge,
    results: z.array(syntheticPgxResultSchema).max(50),
    limitations,
  })
  .superRefine((a, ctx) => {
    unique(a.results, ctx, ['results']);
    if (a.id === a.previousAssessmentId) issue(ctx, ['previousAssessmentId'], 'An assessment cannot supersede itself.');
    if (a.context.patientId !== a.sourceReport.patientId) issue(ctx, ['context'], 'Context patient differs from report patient.');
    if (before(a.generatedAt, a.context.recordedAt)) issue(ctx, ['generatedAt'], 'Assessment precedes context snapshot.');
    a.results.forEach((r, i) => {
      const m = a.context.medications.find((m) => m.id === r.medicationId);
      const cell = a.knowledge.rules.find((k) => k.id === r.sourceRuleId);
      if (!m || m.drug !== r.drug) issue(ctx, ['results', i, 'medicationId'], 'Result must name its context medication/drug.');
      if (r.sourceRuleId && (!cell || cell.drug !== r.drug)) issue(ctx, ['results', i, 'sourceRuleId'], 'Result must name its snapshot rule/drug.');
      if (
        supported(r.disposition) &&
        (!m ||
          !cell ||
          m.status !== 'active' ||
          !m.verifiedAt ||
          m.route !== cell.route ||
          m.indication !== cell.indication ||
          (m.startAt !== null && before(a.context.effectiveAt, m.startAt)))
      )
        issue(ctx, ['results', i, 'disposition'], 'Required medication context is missing or outside rule scope.');
    });
  });

/** Only this aggregate validates cross-report bindings. Component schemas alone cannot establish them. */
export const syntheticPgxPackageSchema = z
  .strictObject({
    schemaVersion: z.literal(SYNTHETIC_PGX_SCHEMA_VERSION),
    synthetic: z.literal(true),
    clinicalUse: z.literal('not-approved'),
    actionable: z.literal(false),
    report: syntheticPgxLabReportSchema,
    assessment: syntheticPgxAssessmentSchema.nullable(),
  })
  .superRefine(({ report: r, assessment: a }, ctx) => {
    if (!a) return;
    if (a.sourceReport.id !== r.id || a.sourceReport.revision !== r.revision || a.sourceReport.patientId !== r.patientId)
      issue(ctx, ['assessment', 'sourceReport'], 'Assessment is bound to a different report revision/patient.');
    if (before(a.generatedAt, r.receivedAt)) issue(ctx, ['assessment', 'generatedAt'], 'Assessment precedes report receipt.');
    a.results.forEach((result, i) => {
      const path = ['assessment', 'results', i];
      const findings = result.findingIds.map((id) => r.findings.find((f) => f.id === id));
      if (findings.some((f) => !f)) issue(ctx, [...path, 'findingIds'], 'Result references an unknown finding.');
      if (!supported(result.disposition)) return;
      if (!['final', 'amended', 'corrected'].includes(r.status) || r.assay.state !== 'provided')
        issue(ctx, [...path, 'disposition'], 'Report lifecycle/manifest does not support assessment.');
      if (findings.some((f) => !f || f.coverage !== 'tested' || f.analyticalState !== 'resolved' || f.interpretationState !== 'interpretable'))
        issue(ctx, [...path, 'findingIds'], 'Uncertain findings cannot support this result.');
      const cell = a.knowledge.rules.find((k) => k.id === result.sourceRuleId);
      if (cell && cell.requiredTargetIds.some((t) => !findings.some((f) => f?.targetId === t))) issue(ctx, [...path, 'findingIds'], 'Combined rule requires every named target.');
    });
  });
export type SyntheticPgxPackage = z.infer<typeof syntheticPgxPackageSchema>;

/** Bound encoded bytes before parsing. This prototype parser is not an authenticated intake endpoint. */
export function parseSyntheticPgxPackage(json: string): SyntheticPgxPackage {
  if (json.length > SYNTHETIC_PGX_MAX_BYTES || new TextEncoder().encode(json).byteLength > SYNTHETIC_PGX_MAX_BYTES)
    throw new Error('Synthetic PGx package exceeds the size limit.');
  return syntheticPgxPackageSchema.parse(JSON.parse(json));
}
