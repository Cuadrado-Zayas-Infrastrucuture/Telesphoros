import type { Env } from '../config/env';
import { currentDataOrigin, DATA_ORIGINS, DataOriginError, requireDataOrigin } from './data-origin';

// Spec 020 E1a: the one function that decides a fact's origin, and the check every writer of a fact repeats.
type OriginEnv = Pick<Env, 'NODE_ENV' | 'LAB_REPORT_PIPELINE'>;
const env = (over: Partial<Record<keyof OriginEnv, string | undefined>>) => ({ NODE_ENV: 'test', LAB_REPORT_PIPELINE: 'enabled', ...over }) as unknown as OriginEnv;

describe('currentDataOrigin', () => {
  it.each(['development', 'test'])('is synthetic in %s with the pipeline on', (nodeEnv) => {
    expect(currentDataOrigin(env({ NODE_ENV: nodeEnv }))).toBe('synthetic');
  });

  it('throws in production, even with the pipeline on, so no synthetic label can be put on production data', () => {
    expect(() => currentDataOrigin(env({ NODE_ENV: 'production' }))).toThrow(DataOriginError);
  });

  it.each([undefined, '', 'staging', 'Production'])('throws for an environment it does not know (%j)', (nodeEnv) => {
    expect(() => currentDataOrigin(env({ NODE_ENV: nodeEnv }))).toThrow(DataOriginError);
  });

  it.each(['disabled', undefined])('throws while the pipeline is not enabled (%j)', (pipeline) => {
    expect(() => currentDataOrigin(env({ LAB_REPORT_PIPELINE: pipeline }))).toThrow(DataOriginError);
  });

  it('never returns `real`: no path may write it yet', () => {
    const seen = new Set<string>();
    for (const NODE_ENV of ['development', 'test', 'production', 'x', undefined])
      for (const LAB_REPORT_PIPELINE of ['enabled', 'disabled', undefined]) {
        try {
          seen.add(currentDataOrigin(env({ NODE_ENV, LAB_REPORT_PIPELINE })));
        } catch {
          // refused, which is the point
        }
      }
    expect([...seen]).toEqual(['synthetic']);
  });
});

describe('requireDataOrigin', () => {
  it.each(DATA_ORIGINS)('accepts %s', (origin) => {
    expect(requireDataOrigin(origin)).toBe(origin);
  });

  it.each([undefined, null, '', 'Synthetic', 'unknown', 0, {}])('refuses %j', (origin) => {
    expect(() => requireDataOrigin(origin)).toThrow(DataOriginError);
  });
});
