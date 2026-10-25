import { z } from 'zod';
import type { KnowledgeSet } from '../knowledge/knowledge-set';
import { contentSha256 } from '../knowledge/content-hash';
import { mapPhenotype } from '../phenotype-engine/phenotype-engine';
import { duplicateInput } from '../report-adapter/adapt-occurrence';
import { inspectPacket, type ParsedOccurrence } from '../report-adapter/packet-checks';
import { comparisonCopy, isUnavailableValue, UNAVAILABLE_TOKENS } from '../report-adapter/unavailable-matcher';
import { bindingMismatches, PINNED_POPPLER_VERSION } from '../report-reader/pinned-reader';
import { readerResultSchema } from '../report-reader/reader-result';
import {
  contextSchema,
  lookupInputSchema,
  policySchema,
  recordSchema,
  scopeSchema,
  snapshotSchema,
  GENES,
  type AdmissionStage,
  type EvidenceRef,
  type GeneState,
  type LookupPorts,
  type LookupReason,
  type OfflineLookupResult,
  type SourceRecord,
  type TrustedProcessingScope,
  type ValidatedBindings,
  type ValidatedRecord,
} from './contracts';
import { artifactHash, boundedScalars, parseRecordJson, recordHash } from './strict-json';
import { routeAdmitted, validatePolicyKnowledge } from './routing';

const OPERATION_MS = 2000;
const same = (a: unknown, b: unknown) => recordHash(a) === recordHash(b);
const scoped = (r: { tenantId: string; reportId: string; captureId: string }, s: TrustedProcessingScope) =>
  r.tenantId === s.tenantId && r.reportId === s.reportId && r.captureId === s.captureId;

/** Cancellation-aware trusted I/O. A port must honor AbortSignal; no retries and no claim of hard resource termination. */
async function operation<T>(action: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      action(controller.signal),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error('evidence-operation-failed'));
        }, OPERATION_MS);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    controller.abort();
  }
}

function currentRecord(snapshot: z.infer<typeof snapshotSchema>, id: string): ValidatedRecord | null {
  const wrappers = snapshot.records.filter((r) => typeof r.payload === 'object' && r.payload !== null && 'id' in r.payload && r.payload.id === id);
  const latest = snapshot.latestReviews.filter((r) => r.recordId === id);
  if (wrappers.length !== 1 || latest.length !== 1) return null;
  const parsed = recordSchema.safeParse(wrappers[0]!.payload);
  if (!parsed.success) return null;
  const payload = parsed.data;
  const recordSha256 = wrappers[0]!.recordSha256;
  if (
    recordHash(payload) !== recordSha256 ||
    payload.review.decision !== 'accepted' ||
    latest[0]!.reviewId !== payload.review.id ||
    latest[0]!.sequence !== payload.review.sequence
  )
    return null;
  return payload;
}

function refFor(textSha256: string, candidate: { start: number; end: number; text: string }): EvidenceRef {
  return { sourceArtifactSha256: textSha256, start: candidate.start, end: candidate.end, literalSha256: artifactHash(candidate.text) };
}
function exactRef(ref: EvidenceRef, sources: ReadonlyMap<string, string>): boolean {
  const source = sources.get(ref.sourceArtifactSha256);
  if (source === undefined || artifactHash(source) !== ref.sourceArtifactSha256) return false;
  const scalars = boundedScalars(source);
  return ref.start < ref.end && ref.end <= scalars.length && artifactHash(scalars.slice(ref.start, ref.end).join('')) === ref.literalSha256;
}
function recordId(state: GeneState): string {
  switch (state.state) {
    case 'canonical':
      return state.derivationRecordId;
    case 'absent':
      return state.coverageRecordId;
    case 'approved-unavailable':
      return state.reviewRecordId;
    case 'empty':
      return state.emptyFieldRecordId;
    default:
      return state.evidenceRecordId;
  }
}

/** Offline, opt-in boundary. No controller imports this. Trusted stores and authenticated scope are separate from payload. */
export async function lookupOffline(rawInput: string, scopeInput: TrustedProcessingScope, ports: LookupPorts, knowledge: KnowledgeSet): Promise<OfflineLookupResult> {
  const bindings: ValidatedBindings = {
    inputRecordSha256: null,
    textSha256: null,
    packetHash: null,
    contextRecordSha256: null,
    policySha256: null,
    captureAcceptanceId: null,
  };
  const diagnostics: OfflineLookupResult['diagnostics'] = [];
  let snapshotVersion: string | null = null;
  const dependencyRecords: OfflineLookupResult['dependencyRecords'] = [];
  const finish = (outcome: OfflineLookupResult['outcome']): OfflineLookupResult => ({ outcome, diagnostics, snapshotVersion, dependencyRecords });
  const hold = (stage: AdmissionStage, reasonCode: LookupReason): OfflineLookupResult => {
    if (!diagnostics.some((d) => d.stage === stage && d.reasonCode === reasonCode)) diagnostics.push({ stage, reasonCode });
    return finish({ schema: 'report-lookup-admission-failure/1', stage, reasonCode, bindings: { ...bindings }, selectedRow: null });
  };
  let stage: AdmissionStage = 'input';
  try {
    const raw = parseRecordJson(rawInput);
    const shell = z.object({ captureAcceptanceId: z.string().min(1).max(128) }).safeParse(raw);
    if (!shell.success) return hold('input', 'lookup-input-invalid');
    const scope = scopeSchema.safeParse(scopeInput);
    if (!scope.success || !ports || typeof ports.readSnapshot !== 'function' || typeof ports.currentVersion !== 'function' || typeof ports.replaySource !== 'function')
      return hold('capture', 'capture-not-accepted');
    stage = 'capture';
    const parsed = snapshotSchema.safeParse(parseRecordJson(await operation((signal) => ports.readSnapshot(scope.data, signal))));
    if (!parsed.success) return hold(stage, 'lookup-input-invalid');
    // Clone through strict JSON: port mutation after the read cannot change this snapshot.
    const snapshot = parsed.data;
    snapshotVersion = snapshot.version;
    const capture = snapshot.capture;
    if (
      !scoped(capture, scope.data) ||
      !scoped(capture.acceptance, scope.data) ||
      capture.acceptance.decision !== 'accepted' ||
      capture.acceptance.id !== shell.data.captureAcceptanceId ||
      capture.createdBy === capture.acceptance.reviewerId
    )
      return hold(stage, 'capture-not-accepted');
    boundedScalars(capture.text);
    if (
      artifactHash(capture.text) !== capture.textSha256 ||
      capture.acceptance.textSha256 !== capture.textSha256 ||
      capture.acceptance.pdfSha256 !== capture.pdfSha256 ||
      capture.acceptance.objectVersion !== capture.objectVersion ||
      capture.acceptance.popplerVersion !== capture.popplerVersion
    )
      return hold(stage, 'capture-hash-mismatch');
    bindings.textSha256 = capture.textSha256;
    bindings.captureAcceptanceId = capture.acceptance.id;
    if (capture.popplerVersion !== PINNED_POPPLER_VERSION) return hold(stage, 'poppler-version-mismatch');
    const sources = new Map<string, string>([[capture.textSha256, capture.text]]);
    for (const source of snapshot.sources) {
      boundedScalars(source.text);
      if (artifactHash(source.text) !== source.sha256 || sources.has(source.sha256)) return hold('packet', 'lookup-input-invalid');
      sources.set(source.sha256, source.text);
    }
    stage = 'packet';
    const readerParsed = readerResultSchema.safeParse(snapshot.reader);
    if (!readerParsed.success) return hold(stage, 'packet-invalid');
    const reader = readerParsed.data;
    if (reader.packet.schema !== 'pgx-span-candidates/3-draft') return hold(stage, 'reader-held');
    if (bindingMismatches(reader.packet).length !== 0) return hold(stage, 'reader-binding-mismatch');
    // The legacy checker validates internal consistency, not full source grammar/accounting.
    // Replay the existing pinned generator rather than inventing a second parser or trusting a rehashed ledger.
    const replay = readerResultSchema.safeParse(parseRecordJson(await operation((signal) => ports.replaySource(scope.data, capture.text, signal))));
    if (!replay.success || !same(replay.data, reader)) return hold(stage, 'packet-invalid');
    const inspection = inspectPacket(capture.text, reader);
    if (!inspection.ok) return hold(stage, inspection.code);
    bindings.packetHash = reader.packet.packetHash;
    stage = 'association';
    if (inspection.kind === 'reader-held') return hold(stage, 'reader-held');
    if (inspection.kind === 'abstained')
      return finish({
        schema: 'report-lookup-abstention/1',
        reasonCode: 'association-abstained',
        bindings: { ...bindings },
        selectedRow: null,
      });
    const occurrences = inspection.occurrences;
    const groups = new Map<string, ParsedOccurrence[]>();
    for (const occurrence of occurrences) groups.set(occurrence.facts.gene, [...(groups.get(occurrence.facts.gene) ?? []), occurrence]);
    if ([...groups.keys()].some((g) => !GENES.includes(g as (typeof GENES)[number]))) return hold(stage, 'lookup-input-invalid');
    // Keep every discovered duplicate/empty fact; primary reason follows fixed gate order and source occurrence order.
    for (const [g, list] of groups)
      if (list.length > 1)
        diagnostics.push({
          stage: 'duplicate',
          reasonCode: duplicateInput(
            g,
            list.map((o) => o.facts),
          ).note,
        });
    for (const o of occurrences) if (o.emptyRoles.length > 0) diagnostics.push({ stage: 'field', reasonCode: 'reported-field-empty' });
    if (diagnostics.length > 0) return hold(diagnostics[0]!.stage, diagnostics[0]!.reasonCode);

    // Context/input schema is deliberately delayed so stronger packet/empty gates cannot be cleared by omission.
    const provisional = z.object({ geneStates: z.array(lookupInputSchema.shape.geneStates.element).length(2) }).safeParse(raw);
    if (!provisional.success || new Set(provisional.data.geneStates.map((s) => s.gene)).size !== 2) return hold('input', 'lookup-input-invalid');
    const states = provisional.data.geneStates;
    stage = 'reconciliation';
    for (const state of [...states].sort((a, b) => (groups.get(a.gene)?.[0]?.resultSpan?.start ?? 100001) - (groups.get(b.gene)?.[0]?.resultSpan?.start ?? 100001))) {
      const record = currentRecord(snapshot, recordId(state));
      if (
        !record ||
        !('gene' in record) ||
        !scoped(record, scope.data) ||
        record.gene !== state.gene ||
        record.textSha256 !== capture.textSha256 ||
        record.packetHash !== reader.packet.packetHash ||
        record.generatorCodeHash !== reader.packet.generatorCodeHash ||
        record.evidence.some((ref) => !exactRef(ref, sources))
      )
        return hold(stage, 'lookup-input-invalid');
      dependencyRecords.push({ id: record.id, recordSha256: recordHash(record) });
      const list = groups.get(state.gene) ?? [];
      if (state.state === 'absent') {
        const regions = z.array(z.strictObject({ start: z.number().int().min(0), end: z.number().int().min(0) })).safeParse(reader.packet.reportRegions);
        if (
          record.type !== 'coverage' ||
          list.length !== 0 ||
          record.occurrenceIndex !== null ||
          record.frameId !== null ||
          record.evidence.length !== 0 ||
          record.anchorPolicySha256 !== reader.packet.grammarHash ||
          record.regionRuleId !== 'pinned-report-region/1' ||
          !regions.success ||
          !regions.data.some((r) => same(r, record.region)) ||
          record.region.start >= record.region.end ||
          record.region.end > boundedScalars(capture.text).length
        )
          return hold(stage, 'lookup-input-invalid');
        continue;
      }
      if (list.length !== 1 || record.type === 'coverage') return hold(stage, 'lookup-input-invalid');
      const occurrence = list[0]!;
      const frame = reader.packet.frames.find((f) => f.frameId === record.frameId);
      const geneCandidate = frame && reader.packet.candidates.find((c) => c.candidateId === frame.geneCandidateId);
      const candidates = [geneCandidate, occurrence.diplotypeSpan, occurrence.resultSpan].filter((c) => c !== null && c !== undefined);
      if (
        !frame ||
        !geneCandidate ||
        geneCandidate.text !== state.gene ||
        record.occurrenceIndex !== occurrence.occurrenceIndex ||
        !same(frame.allowed.diplotype, occurrence.diplotypeSpan ? [occurrence.diplotypeSpan.candidateId] : []) ||
        !same(frame.allowed.reportedResult, occurrence.resultSpan ? [occurrence.resultSpan.candidateId] : []) ||
        !same(record.facts, occurrence.facts) ||
        !same(
          record.candidateIds,
          candidates.map((c) => c.candidateId),
        ) ||
        !same(
          record.evidence,
          candidates.map((c) => refFor(capture.textSha256, c)),
        )
      )
        return hold(stage, 'lookup-input-invalid');
      const { diplotype, result } = occurrence.facts;
      const map = knowledge.gene(state.gene);
      let reconciled: string | null = null;
      if (diplotype.state === 'present') {
        const mapping = map && mapPhenotype(map, diplotype.text);
        if (!mapping || mapping.status === 'unresolved') return hold(stage, mapping?.reasonCode ?? 'no-gene-definition');
        if (result.state !== 'present' || !map!.phenotypes.includes(result.text)) return hold(stage, 'other-gene-unresolved');
        if (mapping.phenotype !== result.text) return hold(stage, 'conflicting-gene-inputs');
        reconciled = mapping.phenotype;
      } else if (result.state === 'present' && map?.phenotypes.includes(result.text)) reconciled = result.text;
      if (state.state === 'canonical') {
        const file = map && knowledge.files.find((f) => f.id === map.id && f.kind === 'gene-phenotype-map');
        if (
          record.type !== 'derivation' ||
          reconciled !== state.phenotype ||
          record.phenotype !== state.phenotype ||
          record.knowledgeSetId !== knowledge.id ||
          !map ||
          !file ||
          file.reviewStatus !== 'reviewed' ||
          map.review.status !== 'reviewed' ||
          map.review.contentSha256 !== contentSha256(map) ||
          file.contentSha256 !== contentSha256(map) ||
          record.mappingFileId !== map.id ||
          record.mappingContentSha256 !== file.contentSha256
        )
          return hold(stage, 'lookup-input-invalid');
      } else if (state.state === 'approved-unavailable') {
        if (
          snapshot.matcherPolicyBytes === null ||
          record.type !== 'unavailable' ||
          diplotype.state !== 'missing' ||
          result.state !== 'present' ||
          !isUnavailableValue(result.text) ||
          !occurrence.resultSpan ||
          !same(state.valueEvidence, refFor(capture.textSha256, occurrence.resultSpan)) ||
          !same(record.valueEvidence, state.valueEvidence) ||
          record.matcherPolicySha256 !== state.matcherPolicySha256 ||
          record.routingPolicySha256 !== (raw as Record<string, unknown>).policySha256 ||
          artifactHash(snapshot.matcherPolicyBytes) !== state.matcherPolicySha256
        )
          return hold(stage, 'lookup-input-invalid');
        const matcher = parseRecordJson(snapshot.matcherPolicyBytes);
        if (!same(matcher, { schema: 'unavailable-matcher-policy/1', unicode: '16.0', algorithm: 'r06/1', tokens: UNAVAILABLE_TOKENS })) return hold(stage, 'lookup-input-invalid');
      } else if (state.state === 'sentinel') {
        if (
          record.type !== 'sentinel' ||
          result.state !== 'present' ||
          !['no result', 'sin resultado'].includes(comparisonCopy(result.text)) ||
          !occurrence.resultSpan ||
          !same(state.valueEvidence, refFor(capture.textSha256, occurrence.resultSpan)) ||
          !same(record.valueEvidence, state.valueEvidence)
        )
          return hold(stage, 'lookup-input-invalid');
        return hold(stage, 'sentinel-literal-in-source');
      } else if (state.state === 'unresolved') {
        if (record.type !== 'unresolved' || reconciled !== null || state.reasonCode !== 'other-gene-unresolved' || record.reasonCode !== state.reasonCode)
          return hold(stage, 'lookup-input-invalid');
        return hold(stage, state.reasonCode);
      } else return hold('field', 'reported-field-empty');
    }
    stage = 'context';
    const contextRaw = (raw as Record<string, unknown>).context;
    if (contextRaw === undefined || contextRaw === null) return hold(stage, 'lookup-context-required');
    const contextParsed = contextSchema.safeParse(contextRaw);
    if (!contextParsed.success) return hold(stage, 'lookup-context-invalid');
    const context = contextParsed.data;
    const contextReview = currentRecord(snapshot, context.reviewRecordId);
    if (!contextReview || contextReview.type !== 'context-review' || !scoped(contextReview, scope.data)) return hold(stage, 'lookup-context-invalid');
    const contextHash = recordHash(context);
    if (
      contextReview.contextRecordSha256 !== contextHash ||
      contextReview.sourceArtifactSha256 !== context.sourceArtifactSha256 ||
      (context.sourceKind === 'report' && context.sourceArtifactSha256 !== capture.textSha256) ||
      context.drugEvidence.sourceArtifactSha256 !== context.sourceArtifactSha256 ||
      context.populationEvidence.sourceArtifactSha256 !== context.sourceArtifactSha256 ||
      !same(contextReview.drugEvidence, context.drugEvidence) ||
      !same(contextReview.populationEvidence, context.populationEvidence) ||
      !exactRef(context.drugEvidence, sources) ||
      !exactRef(context.populationEvidence, sources)
    )
      return hold(stage, 'lookup-context-source-mismatch');
    bindings.contextRecordSha256 = contextHash;
    dependencyRecords.push({ id: contextReview.id, recordSha256: recordHash(contextReview) });
    stage = 'policy';
    if (snapshot.policyBytes === null) return hold(stage, 'lookup-policy-invalid');
    const policyParsed = policySchema.safeParse(parseRecordJson(snapshot.policyBytes));
    if (!policyParsed.success) return hold(stage, 'lookup-policy-invalid');
    const policy = policyParsed.data;
    const policyHash = artifactHash(snapshot.policyBytes);
    const policyReview = currentRecord(snapshot, policy.reviewRecordId);
    if (
      !policyReview ||
      policyReview.type !== 'policy-review' ||
      policyReview.policySha256 !== policyHash ||
      policyReview.knowledgeSetId !== knowledge.id ||
      !same(policyReview.reviewedRows, policy.reviewedRows) ||
      snapshot.knowledgeSetId !== knowledge.id ||
      policy.knowledgeSetId !== knowledge.id ||
      policy.id !== (raw as Record<string, unknown>).policyId ||
      policyHash !== (raw as Record<string, unknown>).policySha256
    )
      return hold(stage, 'lookup-policy-invalid');
    const policyCheck = validatePolicyKnowledge(policy, knowledge, snapshot.disputedRows);
    if (!policyCheck.ok) return hold(stage, policyCheck.reasonCode);
    bindings.policySha256 = policyHash;
    dependencyRecords.push({ id: policyReview.id, recordSha256: recordHash(policyReview) });
    stage = 'input';
    const input = lookupInputSchema.safeParse(raw);
    if (!input.success || input.data.textSha256 !== bindings.textSha256 || input.data.packetHash !== bindings.packetHash) return hold(stage, 'lookup-input-invalid');
    bindings.inputRecordSha256 = recordHash(input.data);
    if ((await operation((signal) => ports.currentVersion(scope.data, signal))) !== snapshot.version) return hold('capture', 'snapshot-changed');
    return finish({
      schema: 'report-lookup-decision/1',
      inputRecordSha256: bindings.inputRecordSha256,
      policySha256: policyHash,
      contextRecordSha256: contextHash,
      decision: routeAdmitted(states, policy, knowledge),
    });
  } catch {
    // Deliberately never expose exception text, source text or protected identifiers.
    return hold(
      stage,
      stage === 'input' ? 'lookup-input-invalid' : stage === 'context' ? 'lookup-context-invalid' : stage === 'policy' ? 'lookup-policy-invalid' : 'evidence-operation-failed',
    );
  }
}

// Exported only for constructing strict offline fixtures, not as a validation bypass.
export type { SourceRecord };
