import type { Env } from '../config/env';

/**
 * Where a fact's data came from (spec 020, E7 and tasks P3): `synthetic` (test or development data) or `real`. It is decided by the server and
 * stored in the fact's provenance row; no request field ever sets it. The column has no default, so a path that cannot name its origin stores nothing.
 */
export const DATA_ORIGINS = ['synthetic', 'real'] as const;
export type DataOrigin = (typeof DATA_ORIGINS)[number];

/** A fact was about to be stored without a usable origin. Nothing was written. */
export class DataOriginError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DataOriginError';
  }
}

/**
 * The origin of data this process writes. `synthetic` while the lab-report pipeline cannot run in production (env.ts refuses
 * LAB_REPORT_PIPELINE=enabled when NODE_ENV=production); anything else throws. `real` is allowed by the database but no path may write it
 * until real data is admitted on purpose (a later change that names who decides it), so this function never returns it.
 */
export function currentDataOrigin(env: Pick<Env, 'NODE_ENV' | 'LAB_REPORT_PIPELINE'>): DataOrigin {
  if (env.NODE_ENV !== 'development' && env.NODE_ENV !== 'test') {
    throw new DataOriginError('The origin of this data cannot be named: only a non-production environment is known to hold synthetic data.');
  }
  if (env.LAB_REPORT_PIPELINE !== 'enabled') throw new DataOriginError('The origin of this data cannot be named: the lab-report pipeline is not enabled.');
  return 'synthetic';
}

/**
 * The origin of a stored structured revision's assessment (spec 032 S3). `synthetic` when the environment has been switched to hold only synthetic data
 * (SYNTHETIC_ASSESSMENT, set by the infrastructure of the synthetic staging and refused beside the pipeline); otherwise exactly what `currentDataOrigin`
 * says, so a development run with the pipeline on behaves as before. Like it, this never returns `real`.
 */
export function structuredAssessmentOrigin(env: Pick<Env, 'NODE_ENV' | 'LAB_REPORT_PIPELINE' | 'SYNTHETIC_ASSESSMENT'>): DataOrigin {
  return env.SYNTHETIC_ASSESSMENT === 'enabled' ? 'synthetic' : currentDataOrigin(env);
}

/** The repository's own check, so a caller that skips the type system (or a future path that forgets the field) is refused before a row is written. */
export function requireDataOrigin(origin: unknown): DataOrigin {
  if (origin !== 'synthetic' && origin !== 'real') throw new DataOriginError('A fact cannot be stored without a data origin.');
  return origin;
}
