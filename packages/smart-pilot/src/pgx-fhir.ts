import crypto from "node:crypto";
import { z } from "zod";

// Deliberately finite source documents: this rehearsal cannot ingest arbitrary reports.
export const SOURCE_TEXT = [
  "SYNTHETIC ONLY. PGx source report version 1. CYP2C19 *1/*1. Not approved for clinical use.\n",
  "SYNTHETIC ONLY. PGx source report version 2. CYP2C19 *1/*2. Not approved for clinical use.\n",
] as const;
const id = z.string().regex(/^[A-Za-z0-9.-]{1,64}$/);
const syntheticVersion = z.string().regex(/^synthetic-[A-Za-z0-9./-]{1,80}$/);
const evaluationSchema = z.strictObject({
  tenantId: z.literal("synthetic-office"),
  patientId: z.string().regex(/^pat_[a-f0-9]{24}$/),
  evaluationId: id,
  createdAt: z.iso.datetime(),
  engineVersion: syntheticVersion,
  knowledgeSetId: syntheticVersion,
  clinicalUse: z.literal("not-approved"),
  actionable: z.literal(false),
  disposition: z.enum(["held", "evaluated"]),
  state: z.enum(["active", "retracted", "superseded"]),
  current: z.boolean(),
  activeDisputes: z.number().int().min(0),
  acceptance: z.strictObject({
    id, decision: z.enum(["accepted", "rejected"]), current: z.boolean(),
  }),
  source: z.strictObject({
    reportId: id,
    versionId: id,
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    text: z.enum(SOURCE_TEXT),
  }),
  genes: z.array(z.strictObject({
    gene: z.literal("CYP2C19"),
    diplotype: z.enum(["*1/*1", "*1/*2"]),
    phenotype: z.enum(["Synthetic normal metabolizer", "Synthetic intermediate metabolizer"]),
  })).length(1),
});
export const pgxVersionsSchema = z.strictObject({
  selectedEvaluationId: id,
  versions: z.array(evaluationSchema).min(1).max(20),
});

const NS = "https://telesphoros.app/synthetic-smart-pilot";
const digest = (value: string) => crypto.createHash("sha256").update(value).digest("hex");
const concept = (code: string, text: string) => ({ coding: [{ system: `${NS}/codes`, code }], text });
const identifier = (kind: string, value: string) => ({ system: `${NS}/${kind}`, value });
const extension = (name: string, value: string) => ({ url: `${NS}/StructureDefinition/${name}`, valueString: value });
const tag = { system: NS, code: "synthetic-not-for-clinical-use" };

/** Local immutable snapshots, not FHIR server revisions, clinical interpretation or EHR writes. */
export function mapPgxToFhir(input: unknown, binding: {
  tenantId: string; patientId: string; fhirPatient: string; issuer: string;
  consent: boolean; interpretable: boolean; contextReady: boolean;
}) {
  if (!binding.consent || !binding.interpretable || !binding.contextReady ||
      !/^[A-Za-z0-9.-]{1,64}$/.test(binding.fhirPatient)) return null;
  const parsed = pgxVersionsSchema.safeParse(input);
  if (!parsed.success) return null;
  const { versions, selectedEvaluationId } = parsed.data;
  if (new Set(versions.map(v => v.evaluationId)).size !== versions.length ||
      versions.some(v => v.patientId !== binding.patientId || v.tenantId !== binding.tenantId)) return null;
  const selected = versions.find(v => v.evaluationId === selectedEvaluationId);
  // Never choose a previous active result if the selected/current one is held or retracted.
  if (!selected || versions.filter(v => v.current).length !== 1 ||
      !selected.current || selected.state !== "active" || selected.disposition !== "evaluated" ||
      selected.activeDisputes !== 0 || selected.acceptance.decision !== "accepted" ||
      !selected.acceptance.current || digest(selected.source.text) !== selected.source.sha256) return null;
  // A source version is immutable even when several interpretations depend on it.
  const sources = new Map<string, string>();
  for (const v of versions) {
    const key = JSON.stringify([v.source.reportId, v.source.versionId]);
    if (digest(v.source.text) !== v.source.sha256 ||
        (sources.has(key) && sources.get(key) !== v.source.sha256)) return null;
    sources.set(key, v.source.sha256);
  }
  return buildPgxCollection(selected, binding, { kind: "embedded", ...selected.source });
}

export interface PgxSnapshot {
  evaluationId: string; createdAt: string; engineVersion: string; knowledgeSetId: string;
  acceptance: { id: string }; captureId?: string; correctionRevision?: string;
  genes: { gene: string; diplotype: string | null; phenotype: string }[];
}
export type PgxSource = { kind: "embedded"; reportId: string; versionId: string; sha256: string; text: string }
  | { kind: "stored-pdf"; reportId: string; versionId: string; sha256: string; data: string; size: number }
  | { kind: "stored-reference"; reportId: string; sha256: string };
export interface FhirBinding {
  tenantId: string; patientId: string; fhirPatient: string; issuer: string;
}
type Resource = { resourceType: string; id: string; [field: string]: unknown };

// Called only after the fixture or stored-DTO boundary has checked its own gates.
export function buildPgxCollection(v: PgxSnapshot, binding: FhirBinding, sourceData: PgxSource) {
  const identity = [binding.tenantId, binding.patientId, binding.issuer, binding.fhirPatient];
  const scopedIdentifier = (kind: string, value: string) => identifier(`${kind}/${digest(JSON.stringify(identity)).slice(0, 32)}`, value);
  const makeId = (kind: string, values: unknown) => `${kind}-${digest(JSON.stringify([identity, values])).slice(0, 48)}`;
  const sourceId = makeId("source", sourceData.kind === "embedded" ? {
    reportId: sourceData.reportId, versionId: sourceData.versionId, sha256: sourceData.sha256, text: sourceData.text,
  } : sourceData);
  const reportId = makeId("pgx", v);
  const provenanceId = makeId("provenance", v);
  const patientId = makeId("patient", binding.fhirPatient);
  const deviceId = makeId("device", v.engineVersion);
  const fullUrl = (type: string, resourceId: string) => `${NS}/preview/${type}/${resourceId}`;
  const ref = (type: string, resourceId: string) => ({ reference: fullUrl(type, resourceId) });
  const subject = ref("Patient", patientId);
  const source = ref("DocumentReference", sourceId);
  const observations: Resource[] = v.genes.flatMap(gene => {
    const genotypeId = makeId("genotype", v.genes.length === 1 ? v : [v, gene.gene]);
    const phenotypeId = makeId("phenotype", v.genes.length === 1 ? v : [v, gene.gene]);
    const genotype: Resource[] = gene.diplotype === null ? [] : [{
      resourceType: "Observation", id: genotypeId, status: "final",
      identifier: [scopedIdentifier("genotype", `${v.evaluationId}/${gene.gene}`)], subject,
      code: { coding: [{ system: "http://loinc.org", code: "84413-4" }], text: "Genotype display name" },
      valueCodeableConcept: { text: `${gene.gene} ${gene.diplotype}` }, derivedFrom: [source],
      note: [{ text: "Synthetic supplied diplotype; not computed or clinically approved." }],
    }];
    return [...genotype, {
      resourceType: "Observation", id: phenotypeId, status: "final",
      identifier: [scopedIdentifier("phenotype", `${v.evaluationId}/${gene.gene}`)], subject,
      code: concept("pgx-phenotype", `${gene.gene} synthetic phenotype`),
      valueCodeableConcept: { text: gene.phenotype },
      derivedFrom: [...(gene.diplotype === null ? [] : [ref("Observation", genotypeId)]), source],
      note: [{ text: "Synthetic supplied phenotype; no genotype-to-phenotype calculation was run." }],
    }];
  });
  const resources: Resource[] = [
    {
      resourceType: "Patient", id: patientId,
      identifier: [{ system: `${binding.issuer}/Patient`, value: binding.fhirPatient }],
    },
    {
      resourceType: "Device", id: deviceId,
      deviceName: [{ name: sourceData.kind === "embedded" ? "Synthetic PGx fixture engine" : "Stored synthetic PGx engine", type: "user-friendly-name" }],
      version: [{ value: v.engineVersion }],
    },
    {
      resourceType: "DocumentReference", id: sourceId, status: "current",
      masterIdentifier: scopedIdentifier(sourceData.kind !== "stored-reference" ? "source-version" : "source-digest",
        `${sourceData.reportId}/${sourceData.kind !== "stored-reference" ? sourceData.versionId : sourceData.sha256}`),
      extension: [extension("source-report-id", sourceData.reportId), ...(sourceData.kind !== "stored-reference"
        ? [extension("source-version-id", sourceData.versionId)]
        : [extension("source-retrieval", "not-connected; storage version unavailable in public DTO")])],
      subject,
      description: sourceData.kind !== "stored-reference"
        ? "Pinned synthetic source bytes. Document status is not clinical approval."
        : "Synthetic stored source metadata only. Bytes and storage version have not been retrieved by this preview.",
      content: [{ attachment: {
        extension: [extension("source-sha256", sourceData.sha256)],
        ...(sourceData.kind === "embedded" ? {
          contentType: "text/plain", title: "Synthetic PGx source report",
          data: Buffer.from(sourceData.text, "utf8").toString("base64"),
          size: Buffer.byteLength(sourceData.text, "utf8"),
        } : sourceData.kind === "stored-pdf" ? {
          contentType: "application/pdf", title: "Verified synthetic source PDF", data: sourceData.data, size: sourceData.size,
        } : { contentType: "application/pdf", title: "Synthetic source report reference; retrieval not connected" }),
      } }],
    },
    ...observations,
    {
      resourceType: "DiagnosticReport", id: reportId, status: "final",
      identifier: [scopedIdentifier("evaluation", v.evaluationId)],
      extension: [extension("knowledge-set-id", v.knowledgeSetId), extension("acceptance-id", v.acceptance.id),
        ...(v.captureId ? [extension("capture-id", v.captureId)] : []),
        ...(v.correctionRevision ? [extension("correction-revision", v.correctionRevision)] : [])],
      code: concept("pgx-preview", "Synthetic PGx interpretation snapshot"), subject,
      issued: v.createdAt, result: observations.map(o => ref("Observation", o.id)),
      conclusion: "SYNTHETIC ONLY. Not approved for clinical use. No recommendation or risk assessment generated.",
    },
    {
      resourceType: "Provenance", id: provenanceId,
      target: [ref("DiagnosticReport", reportId), ...observations.map(o => ref("Observation", o.id))],
      recorded: v.createdAt,
      activity: concept("synthetic-mapping", "Mapping supplied synthetic evaluation; no clinical engine invocation"),
      agent: [{ who: ref("Device", deviceId) }], entity: [{ role: "source", what: source }],
    },
  ];
  return {
    resourceType: "Bundle" as const, type: "collection" as const,
    meta: { tag: [tag] },
    entry: resources.map(resource => ({
      fullUrl: fullUrl(resource.resourceType, resource.id), resource: { ...resource, meta: { tag: [tag] } },
    })),
  };
}
export type PgxFhirBundle = ReturnType<typeof buildPgxCollection>;
