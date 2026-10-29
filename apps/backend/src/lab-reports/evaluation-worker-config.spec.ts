import type { Env } from '../config/env';
import { assertRunsProfile, loadEvaluationWorkerConfig } from './evaluation-worker-config';

const digest = (c: string) => c.repeat(64);
const profile = {
  version: 'evaluation-execution-profile/1' as const,
  codeArtifactSha256: digest('a'),
  executionManifestSha256: digest('b'),
  knowledgeSetId: digest('c'),
  recordingsSha256: digest('d'),
};
const env = { LAB_REPORT_PIPELINE: 'enabled', DATABASE_URL: 'postgres://app.invalid/db' } as Env;
const source = {
  EVALUATION_WORKER: 'enabled',
  EVALUATION_WORKER_DATABASE_URL: 'postgres://queue.invalid/db',
  EVALUATION_EXECUTION_PROFILE: JSON.stringify(profile),
  WORKER_ID: 'evaluation-1',
};
const load = (overrides: Record<string, string | undefined> = {}, appEnv: Env = env) => loadEvaluationWorkerConfig(appEnv, { ...source, ...overrides });

describe('the evaluation worker settings', () => {
  it('starts with the switch on, a separate queue login and a whole execution profile (control)', () => {
    expect(load()).toEqual({
      queueDatabaseUrl: 'postgres://queue.invalid/db',
      profile,
      workerId: 'evaluation-1',
      concurrency: 1,
      tenantCap: 1,
      pollMs: 2000,
      drainSeconds: 30,
    });
  });

  it.each([
    ['the switch is off by default', { EVALUATION_WORKER: undefined }, /EVALUATION_WORKER is not enabled/],
    ['the switch is not exactly enabled', { EVALUATION_WORKER: 'yes' }, /EVALUATION_WORKER\b/],
    ['there is no queue login', { EVALUATION_WORKER_DATABASE_URL: undefined }, /EVALUATION_WORKER_DATABASE_URL is required/],
    ['the queue login is the application login', { EVALUATION_WORKER_DATABASE_URL: 'postgres://app.invalid/db' }, /must be the queue login/],
    ['there is no profile', { EVALUATION_EXECUTION_PROFILE: undefined }, /EVALUATION_EXECUTION_PROFILE is missing/],
    ['the profile is not JSON', { EVALUATION_EXECUTION_PROFILE: 'bedrock' }, /EVALUATION_EXECUTION_PROFILE is missing/],
    ['the profile carries a provider field', { EVALUATION_EXECUTION_PROFILE: JSON.stringify({ ...profile, provider: 'bedrock' }) }, /EVALUATION_EXECUTION_PROFILE/],
  ])('refuses to start when %s, naming the setting and not its value', (_case, overrides, message) => {
    let error: Error | undefined;
    try {
      load(overrides);
    } catch (e) {
      error = e as Error;
    }
    expect(error?.message).toMatch(message);
    expect(error?.message).not.toMatch(/invalid\/db|bedrock/);
  });

  // The worker has no request and no sign-in token, so it cannot be issued a capability; it must not run beside an API that uses one.
  it('refuses to start while the session issuer is in use, naming the setting and not its address', () => {
    const attempt = () => load({}, { ...env, ISSUER_URL: 'http://session-issuer:8082' } as Env);
    expect(attempt).toThrow(/EVALUATION_WORKER.*ISSUER_URL/);
    expect(attempt).not.toThrow(/session-issuer|8082/);
  });

  it('gives two containers with the same host name and PID 1 different ids when WORKER_ID is not set', () => {
    const unset = { ...source, WORKER_ID: undefined };
    const a = loadEvaluationWorkerConfig(env, unset, 'evaluation-worker', 1).workerId;
    const b = loadEvaluationWorkerConfig(env, unset, 'evaluation-worker', 1).workerId;
    expect(a).toMatch(/^evaluation-worker:1:[0-9a-f]{8}$/);
    expect(b).toMatch(/^evaluation-worker:1:[0-9a-f]{8}$/);
    expect(a).not.toBe(b);
  });

  it('uses WORKER_ID exactly as given when it is set (control)', () => {
    expect(loadEvaluationWorkerConfig(env, source, 'evaluation-worker', 1).workerId).toBe('evaluation-1');
  });

  it('refuses to start while the lab-report pipeline it runs is disabled', () => {
    expect(() => load({}, { ...env, LAB_REPORT_PIPELINE: 'disabled' })).toThrow(/needs LAB_REPORT_PIPELINE=enabled/);
  });
});

describe('the profile a worker runs', () => {
  it('accepts the knowledge set and recordings it loaded (control)', () => {
    expect(() => assertRunsProfile(profile, { knowledgeSetId: digest('c'), recordingsSha256: digest('d') })).not.toThrow();
  });

  it('refuses a profile naming another knowledge set or other recordings', () => {
    expect(() => assertRunsProfile(profile, { knowledgeSetId: digest('e'), recordingsSha256: digest('d') })).toThrow(/knowledge set/);
    expect(() => assertRunsProfile(profile, { knowledgeSetId: digest('c'), recordingsSha256: digest('e') })).toThrow(/recordings/);
  });
});
