import { writeSync } from 'node:fs';
import { performance } from 'node:perf_hooks';

const phases = ['fixture-create', 'app-start', 'healthy-ready', 'database-drop', 'failed-ready', 'health'] as const;
export type ReadinessPhase = (typeof phases)[number];

/** Test-only: fixed codes and durations, never callback values/errors. Native fd 2 bypasses Jest's buffered console. */
export function createReadinessPhaseTrace(
  sink: (line: string) => void = (line) => {
    writeSync(2, line);
  },
  now: () => number = () => performance.now(),
) {
  let sequence = 0;
  return async <T>(phase: ReadinessPhase, work: () => Promise<T>): Promise<T> => {
    if (!(phases as readonly string[]).includes(phase)) throw new Error('Unsupported readiness phase');
    const started = now();
    const emit = (event: 'start' | 'returned' | 'threw') => {
      const elapsed = event === 'start' ? 0 : now() - started;
      const elapsedMs = Number.isFinite(elapsed) && elapsed >= 0 ? Math.round(elapsed) : null;
      sink(JSON.stringify({ diagnostic: 'readiness-phases-v1', sequence: ++sequence, phase, event, elapsedMs }) + '\n');
    };
    emit('start');
    let result: T;
    try {
      result = await work();
    } catch (error) {
      emit('threw');
      throw error;
    }
    emit('returned');
    return result;
  };
}
