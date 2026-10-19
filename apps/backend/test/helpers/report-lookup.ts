/** Fictional records and decisions ONLY. These are visible development fixtures, never review exports or clinical content. */
import { execFile, execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import type { GeneMapFile, GuidelineFile, KnowledgeFile } from '@telesphoros/cpic-schema';
import { contentSha256, fullSha256, knowledgeSetId } from '../../src/services/knowledge/content-hash';
import { KnowledgeSet } from '../../src/services/knowledge/knowledge-set';
import { inspectPacket } from '../../src/services/report-adapter/packet-checks';
import { UNAVAILABLE_TOKENS } from '../../src/services/report-adapter/unavailable-matcher';
import { readerResultSchema } from '../../src/services/report-reader/reader-result';
import { PINNED_POPPLER_VERSION } from '../../src/services/report-reader/pinned-reader';
import { GENES, type GeneState, type LookupSnapshot, type ReportLookupInputV1, type SertralineRoutingPolicyV1,
  type SourceRecord, type TrustedProcessingScope, type ValidatedRecord } from '../../src/services/report-lookup/contracts';
import { artifactHash, recordHash } from '../../src/services/report-lookup/strict-json';
import { selectorOf } from '../../src/services/report-lookup/routing';

export const ROOT = resolve(__dirname, '../../../..');
export const SCOPE: TrustedProcessingScope = { tenantId: 'test-tenant', reportId: 'test-report', captureId: 'test-capture', actorId: 'test-actor' };
const provenance = { source: 'FICTIONAL OFFLINE TEST ONLY', sourceUrl: 'https://example.invalid/test', retrievedAt: '2026-10-08', sourceVersion: 'test-1', license: 'proprietary', redistribution: 'restricted' } as const;
const markReviewed = <T extends KnowledgeFile>(file: T): T => {
  file.review = { status: 'reviewed', reviewedBy: 'FICTIONAL-TEST-REVIEWER', reviewedAt: '2026-10-08', contentSha256: contentSha256(file) };
  return file;
};
export function testKnowledge(): KnowledgeSet {
  const maps: GeneMapFile[] = GENES.map((gene) => markReviewed({
    schemaVersion: '1.2', id: `test-${gene.toLowerCase()}`, synthetic: true, kind: 'gene-phenotype-map', gene,
    provenance, review: { status: 'unreviewed' }, phenotypes: ['Normal Metabolizer', 'Indeterminate'],
    alleles: [{ name: '*1', function: 'Normal function' }],
    method: { type: 'diplotype-table', rows: [{ diplotype: '*1/*1', phenotype: 'Normal Metabolizer' }] },
  }));
  const guidelines: GuidelineFile[] = [[...GENES], [GENES[0]], [GENES[1]]].map((genes, i) => markReviewed({
    schemaVersion: '1.2', id: ['test-combined', 'test-single-c19', 'test-single-b6'][i]!, synthetic: true,
    kind: 'guideline', provenance, review: { status: 'unreviewed' }, guidelineVersion: 'test-1',
    title: 'FICTIONAL TEST ONLY', drug: 'sertraline', genes, supersedes: [],
    recommendations: [{
      when: Object.fromEntries(genes.map((g) => [g, 'Normal Metabolizer'])),
      locator: { table: i === 0 ? 'Test combined' : 'Test single', row: 'Test row', ...(i === 0 ? { column: 'Test column' } : {}) },
      verification: { state: 'verified', verifiedBy: 'FICTIONAL-TEST-REVIEWER', verifiedAt: '2026-10-08' },
      strength: 'No recommendation', recommendationText: 'FICTIONAL TEST WORDING NEVER EXPOSED',
    }],
  }));
  const files = [...maps, ...guidelines].map((f) => ({
    path: `test/${f.id}.json`, kind: f.kind, id: f.id, synthetic: true,
    reviewStatus: 'reviewed' as const, contentSha256: contentSha256(f),
  }));
  return new KnowledgeSet(knowledgeSetId([...maps, ...guidelines].map((f) => ({ path: `test/${f.id}.json`, fullSha256: fullSha256(f) }))),
    'non-production', maps, guidelines, files);
}
export function testPolicy(knowledge: KnowledgeSet): SertralineRoutingPolicyV1 {
  return {
    schema: 'sertraline-routing-policy/1', id: 'test-policy', drug: 'sertraline', population: 'general', genes: [...GENES],
    combinedGuidelineId: 'test-combined', singleGeneGuidelineIds: { CYP2C19: 'test-single-c19', CYP2B6: 'test-single-b6' },
    reviewedRows: knowledge.guidelinesForDrug('sertraline').flatMap((g) => g.recommendations.map((r) => selectorOf(g.id, r))),
    knowledgeSetId: knowledge.id, reviewRecordId: 'test-policy-review',
  };
}
export const readerFor = (text: string) => readerResultSchema.parse(JSON.parse(execFileSync('python3', [
  '-I', '-B', resolve(ROOT, 'sidecars/report-reader/reader_cli.py'),
  resolve(ROOT, 'knowledge/lab-report-reader/v2-handoff/engine'), 'process',
], { input: JSON.stringify({ text }), encoding: 'utf8', timeout: 3000,
  env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } })));
const review = (id: string) => ({ id: `test-decision-${id}`, reviewerId: 'FICTIONAL-TEST-REVIEWER', sequence: 1, decision: 'accepted' as const });
export function fixture(
  kinds: [GeneState['state'], GeneState['state']] = ['canonical', 'canonical'],
  customText?: string,
) {
  const knowledge = testKnowledge();
  const policy = testPolicy(knowledge);
  const policyBytes = JSON.stringify(policy);
  const matcherPolicyBytes = JSON.stringify({ schema: 'unavailable-matcher-policy/1', unicode: '16.0', algorithm: 'r06/1', tokens: UNAVAILABLE_TOKENS });
  const lines = kinds.flatMap((kind, i) => {
    const g = GENES[i]!;
    switch (kind) {
      case 'absent': return [];
      case 'canonical': return [`${g}: diplotype *1/*1; result Normal Metabolizer`];
      case 'approved-unavailable': return [`${g}: result not available`];
      case 'unresolved': return [`${g}: result "not available"`];
      case 'sentinel': return [`${g}: result no result`];
      case 'empty': return [`${g}: result`];
    }
  });
  const text = customText ?? `${lines.join('\n')}\n`;
  const textSha256 = artifactHash(text);
  const reader = readerFor(text);
  const inspection = inspectPacket(text, reader);
  const packetHash = reader.packet.schema === 'pgx-span-candidates/3-draft' ? reader.packet.packetHash : artifactHash('invalid-packet');
  const snapshot: LookupSnapshot = {
    version: 'test-snapshot-1',
    capture: { ...SCOPE, createdBy: 'FICTIONAL-TEST-AUTHOR', pdfSha256: artifactHash('FICTIONAL-PDF-BYTES'),
      objectVersion: 'test-object-version', text, textSha256, popplerVersion: PINNED_POPPLER_VERSION,
      acceptance: { ...review('capture'), tenantId: SCOPE.tenantId, reportId: SCOPE.reportId, captureId: SCOPE.captureId,
        pdfSha256: artifactHash('FICTIONAL-PDF-BYTES'), objectVersion: 'test-object-version', textSha256, popplerVersion: PINNED_POPPLER_VERSION } },
    reader, records: [], latestReviews: [], sources: [], policyBytes, matcherPolicyBytes, knowledgeSetId: knowledge.id, disputedRows: [],
  };
  // Scope actor is authenticated context, not a capture payload field.
  delete (snapshot.capture as unknown as Record<string, unknown>).actorId;
  const addRecord = (record: ValidatedRecord) => {
    snapshot.records.push({ payload: record, recordSha256: recordHash(record) });
    snapshot.latestReviews.push({ recordId: record.id, reviewId: record.review.id, sequence: record.review.sequence });
  };
  const refs = (c: { start: number; end: number; text: string }) => ({ sourceArtifactSha256: textSha256, start: c.start, end: c.end, literalSha256: artifactHash(c.text) });
  const states: GeneState[] = kinds.map((kind, i) => {
    const g = GENES[i]!; const id = `test-source-${g}`;
    const o = inspection.ok && inspection.kind === 'projected' ? inspection.occurrences.find((o) => o.facts.gene === g) : undefined;
    const packet = reader.packet.schema === 'pgx-span-candidates/3-draft' ? reader.packet : null;
    const frame = packet?.frames.find((f) => f.sourceAnchor === packet.candidates.find((c) => c.candidateId === f.geneCandidateId)?.start
      && packet.candidates.find((c) => c.candidateId === f.geneCandidateId)?.text === g);
    const geneCandidate = frame && packet!.candidates.find((c) => c.candidateId === frame.geneCandidateId)!;
    const candidates = [geneCandidate, o?.diplotypeSpan, o?.resultSpan].filter((c) => c !== null && c !== undefined);
    const base = { id, version: 1 as const, tenantId: SCOPE.tenantId, reportId: SCOPE.reportId, captureId: SCOPE.captureId,
      textSha256, packetHash, generatorCodeHash: packet?.generatorCodeHash ?? artifactHash('invalid-build'),
      gene: g, occurrenceIndex: o?.occurrenceIndex ?? null, frameId: frame?.frameId ?? null,
      evidence: candidates.map(refs), review: review(id) };
    if (kind !== 'absent' && !o) return stateFor(g, kind);
    const occurrence = { ...base, facts: o ? { ...o.facts, gene: g } : { gene: g, diplotype: { state: 'missing' as const }, result: { state: 'missing' as const } },
      candidateIds: candidates.map((c) => c.candidateId) };
    switch (kind) {
      case 'absent': {
        const regions = packet?.reportRegions as Array<{ start: number; end: number }> | undefined;
        addRecord({ ...base, type: 'coverage', anchorPolicySha256: packet?.grammarHash ?? artifactHash('invalid-grammar'),
          region: regions?.[0] ? { ...regions[0] } : { start: 0, end: text.length }, regionRuleId: 'pinned-report-region/1' });
        return { gene: g, state: kind, coverageRecordId: id };
      }
      case 'canonical': {
        const map = knowledge.gene(g)!;
        addRecord({ ...occurrence, type: 'derivation', knowledgeSetId: knowledge.id, mappingFileId: map.id,
          mappingContentSha256: contentSha256(map), phenotype: 'Normal Metabolizer' });
        return { gene: g, state: kind, phenotype: 'Normal Metabolizer', derivationRecordId: id };
      }
      case 'approved-unavailable': {
        const valueEvidence = refs(o!.resultSpan!);
        addRecord({ ...occurrence, type: 'unavailable', matcherPolicySha256: artifactHash(matcherPolicyBytes),
          routingPolicySha256: artifactHash(policyBytes), valueEvidence });
        return { gene: g, state: kind, basis: 'unavailable-token', matcherPolicySha256: artifactHash(matcherPolicyBytes), valueEvidence, reviewRecordId: id };
      }
      case 'sentinel': {
        const valueEvidence = refs(o!.resultSpan!);
        addRecord({ ...occurrence, type: 'sentinel', valueEvidence });
        return { gene: g, state: kind, valueEvidence, evidenceRecordId: id };
      }
      case 'empty':
        addRecord({ ...occurrence, type: 'empty', role: 'reportedResult' });
        return { gene: g, state: kind, emptyFieldRecordId: id };
      case 'unresolved':
        addRecord({ ...occurrence, type: 'unresolved', reasonCode: 'other-gene-unresolved' });
        return { gene: g, state: kind, reasonCode: 'other-gene-unresolved', evidenceRecordId: id };
    }
  });
  const contextText = 'sertraline general';
  const contextSha = artifactHash(contextText);
  snapshot.sources.push({ sha256: contextSha, text: contextText });
  const context: ReportLookupInputV1['context'] = {
    schema: 'report-lookup-context/1', drug: 'sertraline', population: 'general', sourceKind: 'reviewed-external',
    sourceArtifactSha256: contextSha, drugEvidence: { sourceArtifactSha256: contextSha, start: 0, end: 10, literalSha256: artifactHash('sertraline') },
    populationEvidence: { sourceArtifactSha256: contextSha, start: 11, end: 18, literalSha256: artifactHash('general') }, reviewRecordId: 'test-context-review',
  };
  addRecord({ id: context.reviewRecordId, type: 'context-review', version: 1, tenantId: SCOPE.tenantId, reportId: SCOPE.reportId, captureId: SCOPE.captureId,
    sourceArtifactSha256: contextSha, contextRecordSha256: recordHash(context), drugEvidence: context.drugEvidence, populationEvidence: context.populationEvidence,
    review: review('context') });
  addRecord({ id: policy.reviewRecordId, type: 'policy-review', version: 1, policySha256: artifactHash(policyBytes), knowledgeSetId: knowledge.id,
    reviewedRows: policy.reviewedRows, review: review('policy') });
  const input: ReportLookupInputV1 = { schema: 'report-lookup-input/1', textSha256, packetHash, captureAcceptanceId: snapshot.capture.acceptance.id,
    policyId: policy.id, policySha256: artifactHash(policyBytes), context, geneStates: states };
  const ports = {
    readSnapshot: async () => JSON.stringify(snapshot), currentVersion: async () => snapshot.version,
    replaySource: async (_scope: TrustedProcessingScope, source: string, signal: AbortSignal): Promise<string> => new Promise((accept, reject) => {
      const child = execFile('python3', ['-I', '-B', resolve(ROOT, 'sidecars/report-reader/reader_cli.py'),
        resolve(ROOT, 'knowledge/lab-report-reader/v2-handoff/engine'), 'process'],
      { encoding: 'utf8', signal, timeout: 2000, killSignal: 'SIGKILL', maxBuffer: 1048576,
        env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } }, (error, stdout) => {
        if (error) reject(new Error('test-reader-failed')); else accept(stdout);
      });
      child.stdin!.end(JSON.stringify({ text: source }));
    }),
  };
  const rehash = () => { for (const record of snapshot.records) record.recordSha256 = recordHash(record.payload); };
  return { knowledge, policy, snapshot, input, ports, rehash, addRecord };
}

export function stateFor(gene: typeof GENES[number], state: GeneState['state']): GeneState {
  switch (state) {
    case 'canonical': return { gene, state, phenotype: 'Normal Metabolizer', derivationRecordId: 'test-id' };
    case 'absent': return { gene, state, coverageRecordId: 'test-id' };
    case 'unresolved': return { gene, state, reasonCode: 'other-gene-unresolved', evidenceRecordId: 'test-id' };
    case 'empty': return { gene, state, emptyFieldRecordId: 'test-id' };
    default: {
      const valueEvidence = { sourceArtifactSha256: artifactHash('test'), start: 0, end: 1, literalSha256: artifactHash('t') };
      return state === 'sentinel' ? { gene, state, valueEvidence, evidenceRecordId: 'test-id' }
        : { gene, state, basis: 'unavailable-token', valueEvidence, matcherPolicySha256: artifactHash('test-policy'), reviewRecordId: 'test-id' };
    }
  }
}
export type { SourceRecord };
