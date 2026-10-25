import type { Observation } from '../contracts';
import type { ModelIdentity } from '../outcome-v2';

/**
 * The only way the harness talks to a model. There is no tools parameter and no way to add one: a request is exactly these
 * three fields, so a model cannot be handed a capability through this port (D2, OWASP LLM06).
 */
export interface ModelRequest {
  prompt: string;
  templateDigest: string;
  maxOutputUnits: number;
}
export interface ModelReply {
  artifact: unknown;
  observation: Observation | null;
}
/** What a port is, recorded in every receipt (FR-010): the exact model id, the invocation path and the SDK version. */
export type { ModelIdentity };
export interface ModelPort {
  readonly identity: ModelIdentity;
  complete(request: ModelRequest): Promise<ModelReply>;
}

export const REQUEST_KEYS = ['maxOutputUnits', 'prompt', 'templateDigest'] as const;
export function assertRequestShape(request: object): void {
  if (Object.keys(request).sort().join() !== REQUEST_KEYS.join()) throw new Error('PORT_SHAPE');
}
