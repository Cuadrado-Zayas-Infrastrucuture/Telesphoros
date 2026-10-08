import { randomUUID } from 'node:crypto';
import { z } from 'zod';

/**
 * A person's decision about one paired capture (the PDF and the text read from it). Append-only: a record is never
 * changed or deleted; a later decision is a new record. The report points at the record it relies on.
 */
export const captureAcceptanceSchema = z.strictObject({
  id: z.string().min(1).max(100),
  tenantId: z.string().min(1).max(63),
  textSha256: z.string().regex(/^[0-9a-f]{64}$/),
  /** The `pdftotext` version that produced the text, e.g. "26.03.0". */
  popplerVersion: z.string().regex(/^[0-9]+(\.[0-9]+){1,3}$/),
  decision: z.enum(['accepted', 'rejected']),
  reviewer: z.strictObject({ sub: z.string().min(1).max(200), tenantId: z.string().min(1).max(63) }),
  decidedAt: z.string().datetime(),
  note: z.string().max(1000).nullable(),
});
export type CaptureAcceptance = z.infer<typeof captureAcceptanceSchema>;

export type NewCaptureAcceptance = Omit<CaptureAcceptance, 'id' | 'decidedAt'>;

/**
 * Where acceptances live. Asynchronous on purpose, so the in-memory implementation below can be replaced by the database
 * (slice 5B-3) without changing the adapter or anything that calls it. There is no update and no delete.
 */
export interface CaptureAcceptanceStore {
  record(input: NewCaptureAcceptance): Promise<CaptureAcceptance>;
  /** Another tenant's record is never returned: it reads as not found. */
  get(tenantId: string, id: string): Promise<CaptureAcceptance | null>;
}

/** For tests and local development. */
export class InMemoryCaptureAcceptanceStore implements CaptureAcceptanceStore {
  private readonly records = new Map<string, CaptureAcceptance>();

  constructor(private readonly clock: () => Date = () => new Date()) {}

  async record(input: NewCaptureAcceptance): Promise<CaptureAcceptance> {
    const record = captureAcceptanceSchema.parse({ ...input, id: randomUUID(), decidedAt: this.clock().toISOString() });
    // The reviewer must belong to the tenant the record is for: nobody accepts a capture on another tenant's behalf.
    if (record.reviewer.tenantId !== record.tenantId) throw new Error('The reviewer does not belong to the tenant of the capture.');
    this.records.set(record.id, structuredClone(record));
    return structuredClone(record);
  }

  async get(tenantId: string, id: string): Promise<CaptureAcceptance | null> {
    const record = this.records.get(id);
    return record && record.tenantId === tenantId ? structuredClone(record) : null;
  }
}
