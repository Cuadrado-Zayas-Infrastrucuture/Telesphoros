import type { z } from 'zod';
import { systemActor } from './actor';

/** A flat payload: short lower-camel keys, integers, booleans and short strings of letters, digits and hyphens (the database enforces the same). */
export const ID_STRING = /^[A-Za-z0-9-]{1,64}$/;
const KEY = /^[a-z][A-Za-z0-9]{0,31}$/;

export interface JobDefinition<S extends z.ZodType = z.ZodType> {
  /** `uploads.sweep`, `files.verify-stored`: lowercase letters, digits, dots and hyphens. */
  type: string;
  /** What the payload must look like. Parsed on enqueue and again before a handler runs. */
  payload: S;
  maxAttempts: number;
  /** How long a claim lasts without a heartbeat. */
  leaseSeconds: number;
  /** A handler that runs longer than this is abandoned (its job fails with `handler-timeout`). */
  timeoutSeconds: number;
  /** Only for tests: refused by a production worker and never enqueued by the API. */
  testOnly?: boolean;
}

export function defineJob<S extends z.ZodType>(definition: JobDefinition<S>): JobDefinition<S> {
  systemActor(definition.type); // validates the type's shape
  if (!Number.isInteger(definition.maxAttempts) || definition.maxAttempts < 1 || definition.maxAttempts > 20) throw new Error('maxAttempts is 1 to 20');
  if (definition.leaseSeconds < 5 || definition.leaseSeconds > 3600) throw new Error('leaseSeconds is 5 to 3600');
  if (definition.timeoutSeconds < 1 || definition.timeoutSeconds > 24 * 3600) throw new Error('timeoutSeconds is 1 to 86400');
  return definition;
}

/** Throws unless `payload` is a flat object the database would accept. */
export function assertFlatPayload(payload: unknown): asserts payload is Record<string, string | number | boolean> {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) throw new Error('A job payload is an object.');
  const entries = Object.entries(payload);
  for (const [key, value] of entries) {
    if (!KEY.test(key)) throw new Error('A job payload key is a short lower-camel name.');
    const ok = typeof value === 'boolean' || (typeof value === 'number' && Number.isInteger(value)) || (typeof value === 'string' && ID_STRING.test(value));
    if (!ok) throw new Error('A job payload value is an integer, a boolean or a short string of letters, digits and hyphens.');
  }
  if (JSON.stringify(payload).length > 900) throw new Error('A job payload is small.');
}

/** The set of job types a process knows. Both the API (to enqueue) and the worker (to run) build theirs from the same definitions. */
export class JobRegistry {
  private readonly byType = new Map<string, JobDefinition>();
  constructor(definitions: readonly JobDefinition[] = []) {
    for (const definition of definitions) this.add(definition);
  }
  add(definition: JobDefinition): this {
    if (this.byType.has(definition.type)) throw new Error(`Job type ${definition.type} is registered twice.`);
    this.byType.set(definition.type, definition);
    return this;
  }
  get(type: string): JobDefinition | undefined {
    return this.byType.get(type);
  }
  types(options: { includeTestOnly?: boolean } = {}): string[] {
    return [...this.byType.values()].filter((d) => options.includeTestOnly || !d.testOnly).map((d) => d.type).sort();
  }
}
