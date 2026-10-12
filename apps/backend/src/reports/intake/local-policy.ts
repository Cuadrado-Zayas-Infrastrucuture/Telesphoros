import type { Env } from '../../config/env';
import { AppException } from '../../common/app-exception';
export const loopback = (value: string | undefined) => { try {
    return ['localhost', '127.0.0.1', '[::1]'].includes(new URL(value!).hostname);
}
catch {
    return false;
} };
export function assertLocalStorage(env: Env) {
    const disposableDatabase = () => { try {
        return /^(test_|synthetic_storage_)[a-z0-9_]+$/.test(decodeURIComponent(new URL(env.DATABASE_URL!).pathname.slice(1)));
    }
    catch {
        return false;
    } };
    if (env.NODE_ENV === 'production' || env.LAB_REPORT_PIPELINE !== 'disabled' || !env.LOCAL_STORAGE_RUN_ID ||
        (env.STORAGE_DRIVER === 'postgres' && (!loopback(env.DATABASE_URL) || env.DATABASE_SSL !== 'disable' || !disposableDatabase())) ||
        (env.OBJECT_STORAGE_DRIVER === 's3' && (!loopback(env.S3_ENDPOINT) || env.REPORTS_BUCKET !== `synthetic-storage-${env.LOCAL_STORAGE_RUN_ID}`))) {
        throw AppException.unavailable('Validated intake requires an owned disposable local storage run with clinical processing disabled.');
    }
}
