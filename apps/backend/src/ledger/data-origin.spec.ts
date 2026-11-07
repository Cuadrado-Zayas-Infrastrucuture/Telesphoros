import type { Env } from '../config/env';
import { currentDataOrigin, DATA_ORIGINS, DataOriginError, requireDataOrigin, structuredAssessmentOrigin } from './data-origin';

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

// Spec 032 S3: the structured assessment's origin. The switch is the only addition; without it the answer is exactly currentDataOrigin's.
describe('structuredAssessmentOrigin', () => {
  const structured = (over: Record<string, string | undefined>) =>
    ({ NODE_ENV: 'production', LAB_REPORT_PIPELINE: 'disabled', SYNTHETIC_ASSESSMENT: 'enabled', ...over }) as unknown as Pick<
      Env,
      'NODE_ENV' | 'LAB_REPORT_PIPELINE' | 'SYNTHETIC_ASSESSMENT'
    >;

  it('is synthetic when the environment has been switched to hold only synthetic data, in production mode, as the synthetic staging runs', () => {
    expect(structuredAssessmentOrigin(structured({}))).toBe('synthetic');
  });

  it.each(['disabled', undefined, '', 'true'])('throws in production without the switch (%j): production data cannot be labelled synthetic by default', (switchValue) => {
    expect(() => structuredAssessmentOrigin(structured({ SYNTHETIC_ASSESSMENT: switchValue }))).toThrow(DataOriginError);
  });

  it('behaves as currentDataOrigin when the switch is off, for every environment and pipeline setting', () => {
    for (const NODE_ENV of ['development', 'test', 'production', 'staging', undefined])
      for (const LAB_REPORT_PIPELINE of ['enabled', 'disabled', undefined]) {
        const input = structured({ NODE_ENV, LAB_REPORT_PIPELINE, SYNTHETIC_ASSESSMENT: 'disabled' });
        const plain = (() => {
          try {
            return currentDataOrigin(input);
          } catch (error) {
            return error instanceof DataOriginError ? 'refused' : 'other';
          }
        })();
        const structuredAnswer = (() => {
          try {
            return structuredAssessmentOrigin(input);
          } catch (error) {
            return error instanceof DataOriginError ? 'refused' : 'other';
          }
        })();
        expect(structuredAnswer).toBe(plain);
      }
  });

  it('never returns `real`', () => {
    const seen = new Set<string>();
    for (const NODE_ENV of ['development', 'test', 'production', 'x', undefined])
      for (const SYNTHETIC_ASSESSMENT of ['enabled', 'disabled', undefined])
        try {
          seen.add(structuredAssessmentOrigin(structured({ NODE_ENV, SYNTHETIC_ASSESSMENT })));
        } catch {
          // intentional: a refusal is the other answer this function gives
        }
    expect([...seen]).toEqual(['synthetic']);
  });
});
