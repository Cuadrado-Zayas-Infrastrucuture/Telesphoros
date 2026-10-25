import type { Env } from '../../config/env';
import { AppException } from '../../common/app-exception';
export const loopback = (value: string | undefined) => {
  try {
    return ['localhost', '127.0.0.1', '[::1]'].includes(new URL(value!).hostname);
  } catch {
    return false;
  }
};
export function assertLocalStorage(env: Env) {
  const disposableDatabase = () => {
    try {
      return /^(test_|synthetic_storage_)[a-z0-9_]+$/.test(decodeURIComponent(new URL(env.DATABASE_URL!).pathname.slice(1)));
    } catch {
      return false;
    }
  };
  if (
    env.NODE_ENV === 'production' ||
    env.LAB_REPORT_PIPELINE !== 'disabled' ||
    !env.LOCAL_STORAGE_RUN_ID ||
    (env.STORAGE_DRIVER === 'postgres' && (!loopback(env.DATABASE_URL) || env.DATABASE_SSL !== 'disable' || !disposableDatabase())) ||
    (env.OBJECT_STORAGE_DRIVER === 's3' && (!loopback(env.S3_ENDPOINT) || env.REPORTS_BUCKET !== `synthetic-storage-${env.LOCAL_STORAGE_RUN_ID}`))
  ) {
    throw AppException.unavailable('Validated intake requires an owned disposable local storage run with clinical processing disabled.');
  }
}

/**
 * Where the validated intake may run. A disposable local run (LOCAL_STORAGE_RUN_ID) keeps every L1 restriction. Without a run id (M2.2a) it runs
 * in the organization's own scope in any mode, because configuration validation already decides what storage a mode may use; what remains is
 * that the bucket keeps object versions, which the intake checks again before it writes.
 */
export function assertIntakeAllowed(env: Env) {
  if (env.LOCAL_STORAGE_RUN_ID) assertLocalStorage(env);
}
