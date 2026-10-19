import { z } from 'zod';
import { canonicalDiplotype, hasAtMostTwoDecimals, toHundredths } from './diplotype';
import { cpicStrengthSchema } from './vocabulary';

/** Bump when a file's shape changes. Files declare the version they were written for. */
export const KNOWLEDGE_SCHEMA_VERSION = '1.2';

/** The license a source states for its content. "unknown" is a draft state: a reviewed, non-synthetic file may not use it. */
export const KNOWLEDGE_LICENSES = ['cc0-1.0', 'cc-by-4.0', 'cc-by-sa-4.0', 'proprietary', 'unknown'] as const;
/** Whether the content may be redistributed or built into another product. "unknown" has the same limit as the license. */
export const REDISTRIBUTION_STATES = ['allowed', 'restricted', 'unknown'] as const;

const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/; // everything except tab and newline
const SINGLE_LINE_CONTROL = /[\u0000-\u001f\u007f]/;

/** Short text on one line: names, terms, labels. */
const label = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((value) => !SINGLE_LINE_CONTROL.test(value), 'No control characters or line breaks.')
    .refine((value) => value === value.trim(), 'No leading or trailing spaces.');

/** Guideline wording. Kept exactly as written, so tabs and line breaks are allowed. */
const prose = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((value) => !CONTROL.test(value), 'No control characters other than tab and line break.');

export const geneSymbolSchema = z.string().regex(/^[A-Z][A-Za-z0-9-]{0,19}$/, 'A gene symbol such as CYP2C19.');
/** Drug names are stored lower case so matching never depends on how someone capitalised them. */
export const drugNameSchema = z.string().regex(/^[a-z]([a-z0-9 -]{0,58}[a-z0-9])?$/, 'A lower-case drug name.');
export const alleleNameSchema = z.string().regex(/^[A-Za-z0-9*._>+-]{1,40}$/, 'An allele name such as *1 (no "/", "|" or spaces).');
const fileIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,80}$/, 'Lower-case letters, digits and dashes.');
const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/, 'A lowercase hex SHA-256.');

const provenanceSchema = z.strictObject({
  /** Where the content came from, e.g. "CPIC". */
  source: label(200),
  sourceUrl: z.url().refine((value) => value.startsWith('https://'), 'Use an https URL.'),
  /** The day the content was retrieved. */
  retrievedAt: z.iso.date(),
  /** The upstream release or version label, as the source states it. */
  sourceVersion: label(100),
  /** The license the source states for this content, as the reviewer read it. */
  license: z.enum(KNOWLEDGE_LICENSES),
  /** Whether this content may be redistributed or sold on inside another product. */
  redistribution: z.enum(REDISTRIBUTION_STATES),
});
export type Provenance = z.infer<typeof provenanceSchema>;

/**
 * Review sign-off. A reviewed file records WHO signed it, WHEN, and a SHA-256 of the file's content
 * (everything except this block). Change the content afterwards and the hash no longer matches, so
 * the file is rejected until someone reviews it again.
 */
const reviewSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('unreviewed') }),
  z.strictObject({
    status: z.literal('reviewed'),
    reviewedBy: label(100),
    reviewedAt: z.iso.date(),
    contentSha256: sha256Hex,
  }),
]);
export type Review = z.infer<typeof reviewSchema>;

const envelope = {
  schemaVersion: z.literal(KNOWLEDGE_SCHEMA_VERSION),
  id: fileIdSchema,
  /** True for invented test content. Synthetic files are refused in production and can never be signed off. */
  synthetic: z.boolean(),
  provenance: provenanceSchema,
  review: reviewSchema,
};

function addIssue(ctx: z.RefinementCtx, path: (string | number)[], message: string): void {
  ctx.addIssue({ code: 'custom', message, path });
}

/**
 * Real content that carries a reviewer's signature must say what its license allows. Drafts and synthetic
 * files may leave either "unknown", because nothing downstream redistributes them.
 */
function requireStatedLicense(
  file: { synthetic: boolean; provenance: { license: string; redistribution: string }; review: { status: string } },
  ctx: z.RefinementCtx,
): void {
  if (file.synthetic || file.review.status !== 'reviewed') return;
  if (file.provenance.license === 'unknown') addIssue(ctx, ['provenance', 'license'], 'A reviewed file must state its license (not "unknown").');
  if (file.provenance.redistribution === 'unknown') {
    addIssue(ctx, ['provenance', 'redistribution'], 'A reviewed file must state whether it may be redistributed (not "unknown").');
  }
}

/** Ranges of an activity score. Bounds are explicit about being inclusive so no edge is ambiguous. */
const activityValueSchema = z
  .number()
  .min(0)
  .max(100)
  .refine(hasAtMostTwoDecimals, 'At most two decimal places.');

const activityRangeSchema = z.strictObject({
  min: activityValueSchema,
  minInclusive: z.boolean(),
  max: activityValueSchema,
  maxInclusive: z.boolean(),
  phenotype: label(100),
});

const alleleSchema = z.strictObject({
  name: alleleNameSchema,
  /** CPIC's allele functional status, e.g. "Normal function". Free text; the tables refer to it by name. */
  function: label(100),
  /** Required when the gene is mapped by activity score. */
  activityValue: activityValueSchema.optional(),
});

const methodSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('diplotype-table'),
    rows: z.array(z.strictObject({ diplotype: label(100), phenotype: label(100) })).min(1).max(5000),
  }),
  z.strictObject({
    type: z.literal('function-pair'),
    rows: z
      .array(z.strictObject({ functions: z.tuple([label(100), label(100)]), phenotype: label(100) }))
      .min(1)
      .max(500),
  }),
  z.strictObject({
    type: z.literal('activity-score'),
    ranges: z.array(activityRangeSchema).min(1).max(50),
  }),
]);

export const geneMapFileSchema = z
  .strictObject({
    ...envelope,
    kind: z.literal('gene-phenotype-map'),
    gene: geneSymbolSchema,
    /** Needed only to turn a diplotype into a phenotype. A gene a lab reports as a phenotype needs neither. */
    alleles: z.array(alleleSchema).min(1).max(2000).optional(),
    /** Every phenotype term this gene can have. Reported phenotypes and guideline cells may only use these. */
    phenotypes: z.array(label(100)).min(1).max(50),
    method: methodSchema.optional(),
  })
  .superRefine((file, ctx) => {
    requireStatedLicense(file, ctx);
    if ((file.alleles === undefined) !== (file.method === undefined)) {
      addIssue(ctx, ['method'], 'Give both alleles and method (to map diplotypes) or neither (phenotype-only gene).');
      return;
    }
    if (file.alleles === undefined || file.method === undefined) {
      const phenotypes = new Set(file.phenotypes);
      if (phenotypes.size !== file.phenotypes.length) addIssue(ctx, ['phenotypes'], 'Phenotypes must be unique.');
      return;
    }
    const { alleles, method } = file;
    const alleleNames = alleles.map((allele) => allele.name);
    const phenotypes = new Set(file.phenotypes);
    if (phenotypes.size !== file.phenotypes.length) addIssue(ctx, ['phenotypes'], 'Phenotypes must be unique.');
    if (new Set(alleleNames).size !== alleleNames.length) addIssue(ctx, ['alleles'], 'Allele names must be unique.');
    const requirePhenotype = (value: string, path: (string | number)[]) => {
      if (!phenotypes.has(value)) addIssue(ctx, path, 'This phenotype is not in the phenotypes list.');
    };

    if (method.type === 'diplotype-table') {
      const seen = new Set<string>();
      method.rows.forEach((row, index) => {
        const canonical = canonicalDiplotype(alleleNames, row.diplotype);
        if (!canonical) {
          addIssue(ctx, ['method', 'rows', index, 'diplotype'], 'Must be two known alleles written "allele/allele".');
        } else if (seen.has(canonical)) {
          addIssue(ctx, ['method', 'rows', index, 'diplotype'], 'This diplotype appears more than once (order does not matter).');
        } else seen.add(canonical);
        requirePhenotype(row.phenotype, ['method', 'rows', index, 'phenotype']);
      });
    } else if (method.type === 'function-pair') {
      const functions = new Set(alleles.map((allele) => allele.function));
      const seen = new Set<string>();
      method.rows.forEach((row, index) => {
        for (const [position, name] of row.functions.entries()) {
          if (!functions.has(name)) addIssue(ctx, ['method', 'rows', index, 'functions', position], 'No allele has this function.');
        }
        const key = JSON.stringify([...row.functions].sort());
        if (seen.has(key)) addIssue(ctx, ['method', 'rows', index, 'functions'], 'This pair appears more than once (order does not matter).');
        seen.add(key);
        requirePhenotype(row.phenotype, ['method', 'rows', index, 'phenotype']);
      });
    } else {
      alleles.forEach((allele, index) => {
        if (allele.activityValue === undefined) addIssue(ctx, ['alleles', index, 'activityValue'], 'Every allele needs an activityValue for this method.');
      });
      const bounds = method.ranges.map((range, index) => {
        requirePhenotype(range.phenotype, ['method', 'ranges', index, 'phenotype']);
        const low = toHundredths(range.min);
        const high = toHundredths(range.max);
        if (low > high || (low === high && !(range.minInclusive && range.maxInclusive))) {
          addIssue(ctx, ['method', 'ranges', index], 'This range is empty.');
        }
        return { index, low, high, lowInclusive: range.minInclusive, highInclusive: range.maxInclusive };
      });
      // Ranges must not overlap, or one score would map to two phenotypes.
      const sorted = [...bounds].sort((a, b) => a.low - b.low || a.high - b.high);
      let widest: (typeof bounds)[number] | undefined;
      for (const range of sorted) {
        if (widest) {
          const touches = range.low < widest.high || (range.low === widest.high && range.lowInclusive && widest.highInclusive);
          if (touches) addIssue(ctx, ['method', 'ranges', range.index], 'This range overlaps another range.');
        }
        if (!widest || range.high > widest.high || (range.high === widest.high && range.highInclusive)) widest = range;
      }
    }
  });
export type GeneMapFile = z.infer<typeof geneMapFileSchema>;

/** Where the cell sits in the published guideline, so a person can find it and check it. */
const locatorSchema = z.strictObject({
  /** The table as the guideline names it, e.g. "Table 2". */
  table: label(100),
  /** The row label as printed. */
  row: label(100),
  /** The column label as printed; absent for a single-gene table. */
  column: label(100).optional(),
});
export type CellLocator = z.infer<typeof locatorSchema>;

/**
 * Whether this cell's position has been rechecked against the published source. Only `verified`
 * cells can ever be shown; `unverified` and `disputed` cells hold the result.
 */
const cellVerificationSchema = z.discriminatedUnion('state', [
  z.strictObject({ state: z.literal('unverified') }),
  z.strictObject({ state: z.literal('verified'), verifiedBy: label(100), verifiedAt: z.iso.date() }),
  z.strictObject({ state: z.literal('disputed'), note: prose(1000) }),
]);
export type CellVerification = z.infer<typeof cellVerificationSchema>;

const recommendationRowSchema = z.strictObject({
  /** The phenotype of each gene this cell applies to. Exactly the guideline's genes. */
  when: z.record(geneSymbolSchema, label(100)),
  locator: locatorSchema,
  verification: cellVerificationSchema,
  strength: cpicStrengthSchema,
  /** The guideline's wording, kept exactly. The engine never rewrites it. */
  recommendationText: prose(4000),
  implication: prose(2000).optional(),
});
export type RecommendationRow = z.infer<typeof recommendationRowSchema>;

export const guidelineFileSchema = z
  .strictObject({
    ...envelope,
    kind: z.literal('guideline'),
    /** Version of the guideline as its publisher states it, recorded on every result. */
    guidelineVersion: label(50),
    title: label(200),
    drug: drugNameSchema,
    /** The genes this guideline's table is read by: one for a single-gene table, several for a combined table. */
    genes: z.array(geneSymbolSchema).min(1).max(4),
    /**
     * Ids of single-gene guidelines (same drug, a subset of these genes) that this combined table
     * replaces. They are never shown on their own: if this table cannot be applied, the drug's result
     * is held, with no fallback to a narrower row.
     */
    supersedes: z.array(fileIdSchema).max(10),
    recommendations: z.array(recommendationRowSchema).min(1).max(500),
  })
  .superRefine((file, ctx) => {
    requireStatedLicense(file, ctx);
    if (new Set(file.genes).size !== file.genes.length) addIssue(ctx, ['genes'], 'Genes must be unique.');
    if (new Set(file.supersedes).size !== file.supersedes.length) addIssue(ctx, ['supersedes'], 'Ids must be unique.');
    if (file.supersedes.includes(file.id)) addIssue(ctx, ['supersedes'], 'A guideline cannot supersede itself.');
    const wanted = [...file.genes].sort();
    const seen = new Set<string>();
    file.recommendations.forEach((row, index) => {
      const given = Object.keys(row.when).sort();
      if (given.length !== wanted.length || given.some((gene, position) => gene !== wanted[position])) {
        addIssue(ctx, ['recommendations', index, 'when'], 'A cell must give a phenotype for exactly this guideline\'s genes.');
        return;
      }
      const key = JSON.stringify(wanted.map((gene) => row.when[gene]));
      if (seen.has(key)) addIssue(ctx, ['recommendations', index, 'when'], 'This combination of phenotypes appears more than once.');
      seen.add(key);
    });
  });
export type GuidelineFile = z.infer<typeof guidelineFileSchema>;

export const knowledgeFileSchema = z.discriminatedUnion('kind', [geneMapFileSchema, guidelineFileSchema]);
export type KnowledgeFile = z.infer<typeof knowledgeFileSchema>;

