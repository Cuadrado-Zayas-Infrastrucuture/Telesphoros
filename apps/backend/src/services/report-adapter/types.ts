import type { GeneInput } from '@telesphoros/cpic-schema';
import type { CallerReasonCode } from '@telesphoros/cpic-schema';
import type { AdapterNote } from './adapt-occurrence';
import type { ReportHoldCode } from './hold-codes';

/** A place in the accepted text: offsets (Unicode scalars, half-open) and a hash. Never the text itself. */
export interface SpanRef {
  start: number;
  end: number;
  textSha256: string;
}

export type OccurrenceRole = 'diplotype' | 'reportedResult';

export interface EmittedSummary {
  state: GeneInput['state'];
  reasonCode: CallerReasonCode | null;
}

export interface AdapterOccurrence {
  gene: string;
  /** 0-based, per gene, in source order. Meaningful only for this exact text hash. */
  occurrenceIndex: number;
  roles: { diplotype: SpanRef | null; reportedResult: SpanRef | null; emptyRoles: OccurrenceRole[] };
  /**
   * What this occurrence contributed to `geneInputs`, as states and codes only: no diplotype or phenotype text, so the audit
   * trail can be logged and stored without carrying anything from the report. The values are in `geneInputs`, which is
   * what the engine receives. Empty for a repeated gene: its single input is gene-level.
   */
  emitted: EmittedSummary[];
  note: AdapterNote;
}

/** What the result is tied to. Fields not yet known when a report is held early are null. */
export interface SourceBinding {
  textSha256: string;
  popplerVersion: string | null;
  packetHash: string | null;
  generatorCodeHash: string | null;
  captureAcceptanceId: string | null;
}

export type AdapterResult =
  | { disposition: 'held'; code: ReportHoldCode; message: string; reviewerAction: string; binding: SourceBinding }
  | {
      disposition: 'evaluated';
      /** Exactly what is passed to `evaluate()`. */
      geneInputs: GeneInput[];
      occurrences: AdapterOccurrence[];
      binding: SourceBinding;
    };
