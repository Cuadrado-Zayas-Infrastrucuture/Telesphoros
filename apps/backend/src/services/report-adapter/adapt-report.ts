import { type GeneInput, geneInputsSchema } from '@telesphoros/cpic-schema';
import { type ReaderResult, readerResultSchema } from '../report-reader/reader-result';
import { bindingMismatches, PINNED_POPPLER_VERSION } from '../report-reader/pinned-reader';
import type { AdapterKnowledge } from './adapter-knowledge';
import { adaptOccurrence, duplicateInput } from './adapt-occurrence';
import { sha256Hex } from './canonical-json';
import type { CaptureAcceptanceStore } from './capture-acceptance';
import { holdCodeForReaderReason, REPORT_HOLD_ACTIONS, REPORT_HOLD_MESSAGES, type ReportHoldCode } from './hold-codes';
import { inspectPacket, type ParsedOccurrence } from './packet-checks';
import type { AdapterOccurrence, AdapterResult, EmittedSummary, SourceBinding, SpanRef } from './types';

export interface AdaptReportInput {
  tenantId: string;
  /** The acceptance record the report relies on. */
  captureAcceptanceId: string;
  /** The accepted text that was read. The adapter only uses it to check the reader's output against it. */
  text: string;
  reader: ReaderResult;
}

export interface AdaptReportDeps {
  captures: CaptureAcceptanceStore;
  knowledge: AdapterKnowledge;
}

const summarize = (input: GeneInput): EmittedSummary => ({ state: input.state, reasonCode: input.state === 'unresolved' ? input.reasonCode : null });
const spanRef = (span: { start: number; end: number; text: string } | null): SpanRef | null =>
  span ? { start: span.start, end: span.end, textSha256: sha256Hex(span.text) } : null;

/**
 * The report adapter (docs/design/report-adapter-spec.md): turns what the reader found into the engine's existing input
 * contract, or holds the whole report. Fail closed: every check below ends in a named hold, nothing is repaired, and no
 * hold or audit field ever contains text from the report. A held report produces no drug results.
 *
 * Order (spec section 3): accepted capture, pinned Poppler, the reader's own failure, the pinned reader build, packet
 * integrity, disjoint evidence, then the reader's verdict. Throws only for misuse (a non-string).
 */
export async function adaptReport(input: AdaptReportInput, deps: AdaptReportDeps): Promise<AdapterResult> {
  if (typeof input.text !== 'string') throw new TypeError('text must be a string');
  const textSha256 = sha256Hex(input.text);
  let binding: SourceBinding = { textSha256, popplerVersion: null, packetHash: null, generatorCodeHash: null, captureAcceptanceId: null };
  const hold = (code: ReportHoldCode): AdapterResult => ({ disposition: 'held', code, message: REPORT_HOLD_MESSAGES[code], reviewerAction: REPORT_HOLD_ACTIONS[code], binding });

  // 1. A person accepted this capture, for this tenant, and it is this text.
  const acceptance = await deps.captures.get(input.tenantId, input.captureAcceptanceId);
  if (!acceptance || acceptance.decision !== 'accepted') return hold('capture-not-accepted');
  binding = { ...binding, captureAcceptanceId: acceptance.id };
  if (acceptance.textSha256 !== textSha256) return hold('capture-hash-mismatch');

  // 2. It was captured with the pinned Poppler; output from another version is not comparable.
  binding = { ...binding, popplerVersion: acceptance.popplerVersion };
  if (acceptance.popplerVersion !== PINNED_POPPLER_VERSION) return hold('poppler-version-mismatch');

  const parsed = readerResultSchema.safeParse(input.reader);
  if (!parsed.success) return hold('packet-invalid');
  const reader = parsed.data;

  // 3. The reader could not process the text at all (its own failure envelope, which carries no bindings).
  if (reader.packet.schema === 'pgx-span-processing-failure/1') {
    const code = holdCodeForReaderReason(reader.packet.reason);
    const consistent = reader.projection.status === 'held' && reader.projection.reason === reader.packet.reason && reader.projection.payload === null;
    return hold(code !== null && consistent ? code : 'packet-invalid');
  }
  binding = { ...binding, packetHash: reader.packet.packetHash, generatorCodeHash: reader.packet.generatorCodeHash };

  // 4. It was the pinned reader build.
  if (bindingMismatches(reader.packet).length > 0) return hold('reader-binding-mismatch');

  // 5 and 6. The packet is intact, belongs to this text, and its evidence is disjoint.
  const inspection = inspectPacket(input.text, reader);
  if (!inspection.ok) return hold(inspection.code);

  // 7. The reader's own verdict.
  if (inspection.kind === 'reader-held') return hold(holdCodeForReaderReason(inspection.reason) ?? 'packet-invalid');

  const finish = (emitted: GeneInput[], occurrences: AdapterOccurrence[]): AdapterResult => {
    // Every input this adapter emits says where it came from, here and nowhere else, so no path (abstained, duplicate, mapped) can forget it.
    // The occurrences were summarised from the unlabelled inputs and carry no source.
    const geneInputs = emitted.map((input): GeneInput => ({ ...input, callSource: 'lab-report' }));
    // The engine's own contract is the last check: an input it would refuse is a defect here, never passed on.
    if (!geneInputsSchema.safeParse(geneInputs).success) return hold('packet-invalid');
    return { disposition: 'evaluated', geneInputs, occurrences, binding };
  };

  if (inspection.kind === 'abstained') {
    // Genes listed with values that nothing ties to them: each listed gene is abstained, once. The values are dropped.
    const geneInputs = inspection.genes.map((gene): GeneInput => ({ gene, state: 'unresolved', reasonCode: 'association-abstained' }));
    const occurrences = geneInputs.map((emitted): AdapterOccurrence => ({
      gene: emitted.gene,
      occurrenceIndex: 0,
      roles: { diplotype: null, reportedResult: null, emptyRoles: [] },
      emitted: [summarize(emitted)],
      note: 'abstained',
    }));
    return finish(geneInputs, occurrences);
  }

  // Projected: group by gene in source order. A repeated gene is held as a whole; a single occurrence is mapped by the table.
  const byGene = new Map<string, ParsedOccurrence[]>();
  for (const occurrence of inspection.occurrences) byGene.set(occurrence.facts.gene, [...(byGene.get(occurrence.facts.gene) ?? []), occurrence]);

  const geneInputs: GeneInput[] = [];
  const occurrences: AdapterOccurrence[] = [];
  for (const [gene, list] of byGene) {
    const roles = (o: ParsedOccurrence) => ({ diplotype: spanRef(o.diplotypeSpan), reportedResult: spanRef(o.resultSpan), emptyRoles: o.emptyRoles });
    if (list.length > 1) {
      const duplicate = duplicateInput(
        gene,
        list.map((o) => o.facts),
      );
      geneInputs.push(duplicate.input);
      for (const o of list) occurrences.push({ gene, occurrenceIndex: o.occurrenceIndex, roles: roles(o), emitted: [], note: duplicate.note });
      continue;
    }
    const only = list[0]!;
    const adapted = adaptOccurrence(only.facts, deps.knowledge);
    geneInputs.push(...adapted.emitted);
    occurrences.push({ gene, occurrenceIndex: only.occurrenceIndex, roles: roles(only), emitted: adapted.emitted.map(summarize), note: adapted.note });
  }
  return finish(geneInputs, occurrences);
}
