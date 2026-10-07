import type { UploadReportValues } from '@/lib/uploadReportSchema';

const SIMULATED_LATENCY_MS = 800;

export class SubmitError extends Error {}

/**
 * STUB — Phase 1 only. Nothing leaves the browser. Phase 2 replaces this with a real call
 * to the backend. A file whose name contains "fail" simulates a server error, so the
 * "keep the user's input after a failed submit" behaviour can be exercised.
 */
export async function submitReport(values: UploadReportValues): Promise<{ reference: string }> {
  await new Promise((resolve) => setTimeout(resolve, SIMULATED_LATENCY_MS));
  if (values.file.name.toLowerCase().includes('fail')) {
    throw new SubmitError('The server could not accept this report. Your entries are kept, so you can try again.');
  }
  return { reference: `SYN-${crypto.randomUUID().slice(0, 8).toUpperCase()}` };
}
