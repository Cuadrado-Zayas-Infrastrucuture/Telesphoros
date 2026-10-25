/**
 * Fixtures whose owner may be gone before they exist.
 *
 * Jest does not cancel the async work a timed-out hook or test abandons. A fixture that is still being built when that happens finishes later
 * (a Nest application calls `listen`, pools connect) and no one holds it, so nothing closes it. The tier runs Jest in one process, so the
 * leaked listener and sockets keep that process alive forever after the summary (2026-10-17 and 2026-10-20: the step idled until the run's
 * 30-minute deadline). The helpers record every build in flight and every fixture they hand out here; `fixture-environment.cjs` drains
 * whatever is left when the test file ends, while the module registry is still alive (database drops need it).
 *
 * The registry hangs off `globalThis` by a global symbol: a spec that calls `jest.resetModules()` gets fresh helper modules but the same
 * registry, and the environment (another module graph) finds it by the same symbol.
 */
export const FIXTURE_REGISTRY = Symbol.for('telesphoros.test.fixture-registry');

/** A construction that has not settled. `abort` stops it at its next checkpoint; its own failure path then unwinds what it built. */
export interface PendingBuild {
  abort(reason: Error): void;
  /** Settles when the build has returned or unwound; never rejects. */
  settled: Promise<void>;
}
/** A fixture a caller received. `close` is the fixture's own idempotent cleanup. */
export interface LiveFixture {
  close(): Promise<unknown>;
}
interface FixtureRegistry {
  building: Set<PendingBuild>;
  live: Set<LiveFixture>;
}

export function fixtureRegistry(): FixtureRegistry {
  const scope = globalThis as unknown as Record<symbol, FixtureRegistry | undefined>;
  return (scope[FIXTURE_REGISTRY] ??= { building: new Set(), live: new Set() });
}

/**
 * Runs `build` so the end of the test file can cancel it. Settles exactly as `build` does. `outer` is the caller's own cancellation;
 * either one cancels the build.
 */
export function trackedBuild<T>(build: (signal: AbortSignal) => Promise<T>, outer?: AbortSignal): Promise<T> {
  const own = new AbortController();
  const promise = build(outer ? AbortSignal.any([outer, own.signal]) : own.signal);
  const entry: PendingBuild = {
    abort: (reason) => own.abort(reason),
    settled: promise.then(
      () => undefined,
      () => undefined,
    ),
  };
  const { building } = fixtureRegistry();
  building.add(entry);
  return promise.finally(() => {
    building.delete(entry);
  });
}

/** Records a fixture a caller now owns. Returns the function that forgets it once it has been closed. */
export function trackLive(close: () => Promise<unknown>): () => void {
  const entry: LiveFixture = { close };
  const { live } = fixtureRegistry();
  live.add(entry);
  return () => {
    live.delete(entry);
  };
}
