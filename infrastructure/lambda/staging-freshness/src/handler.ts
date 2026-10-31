/** What docs/ops/staging-expected.json holds that this check reads (the file has more; the page guard in test:ci-config checks the rest). */
export interface Facts {
  appliedCommit: string;
  image: { digest: string; commit: string };
  taskDefinitions: { api: number; worker: number };
  alarms: number;
  cloudfrontCachePaths: string[];
  acceptedExceptions: { id: string; reason: string; reviewBy: string }[];
}

export interface Service {
  revision: number;
  digest: string;
}

/** Every read the check makes, and the one write. A source throws when it cannot answer; the check never guesses. */
export interface Sources {
  facts(): Promise<Facts>;
  service(name: 'api' | 'worker'): Promise<Service>;
  alarms(): Promise<number>;
  cloudfrontPaths(): Promise<string[]>;
  /** The HTTP status of the API's readiness route. */
  ready(): Promise<number>;
  /** Files under infrastructure/terraform/ that changed between the commit and main. `truncated` when GitHub cut its answer short. */
  terraformFilesSince(commit: string): Promise<{ files: string[]; truncated: boolean }>;
  /** When the first application change the image does not contain merged, if there is one. */
  applicationChangeSince(commit: string): Promise<{ since: string | undefined }>;
  publish(subject: string, message: string): Promise<void>;
}

export interface Finding {
  field: string;
  expected: string;
  live: string;
}

export interface Result {
  complete: boolean;
  findings: Finding[];
  problems: string[];
}

/** A change in the image's source this many days old and still not released is a finding (spec 027, D4). */
export const IMAGE_BEHIND_DAYS = 7;
const DAY_MS = 86_400_000;
const MAX_FILES_LISTED = 10;

/** Text from a source or a fact, made safe for an email: control characters out, one line, bounded. */
const clean = (value: unknown, max = 200): string => String(value).replace(/[^\x20-\x7e]/g, '').slice(0, max);
/** `sha256:` and the first twelve hex digits, which is how environments.md names an image. */
const short = (digest: string): string => clean(digest).slice(0, 19);

const errorName = (e: unknown): string => clean(e instanceof Error ? e.name : 'Error', 60);

/** Runs one read; a failure is recorded by the read's name and the error's class only (never its message, which can carry an ARN). */
async function attempt<T>(name: string, problems: string[], read: () => Promise<T>): Promise<T | undefined> {
  try {
    return await read();
  } catch (e) {
    problems.push(`${name}: ${errorName(e)}`);
    return undefined;
  }
}

const differs = (field: string, expected: string, live: string): Finding => ({ field, expected: clean(expected, 700), live: clean(live, 700) });

/**
 * Compares staging with its facts and the repository with what is applied. Counts, digests, revisions and file names only.
 * `now` is the clock the caller reads once, so a run and its tests agree on today.
 */
export async function run(sources: Sources, now: Date = new Date()): Promise<Result> {
  const problems: string[] = [];
  const findings: Finding[] = [];
  const facts = await attempt('facts', problems, () => sources.facts());

  if (facts) {
    const [api, worker, alarms, paths, ready] = await Promise.all([
      attempt('api', problems, () => sources.service('api')),
      attempt('worker', problems, () => sources.service('worker')),
      attempt('alarms', problems, () => sources.alarms()),
      attempt('cloudfront', problems, () => sources.cloudfrontPaths()),
      attempt('ready', problems, () => sources.ready()),
    ]);
    for (const [name, live, revision] of [['api', api, facts.taskDefinitions.api], ['worker', worker, facts.taskDefinitions.worker]] as const) {
      if (!live) continue;
      if (live.revision !== revision) findings.push(differs(`${name}.revision`, String(revision), String(live.revision)));
      if (live.digest !== facts.image.digest) findings.push(differs(`${name}.digest`, short(facts.image.digest), short(live.digest)));
    }
    if (alarms !== undefined && alarms !== facts.alarms) findings.push(differs('alarms', String(facts.alarms), String(alarms)));
    if (paths && JSON.stringify([...paths].sort()) !== JSON.stringify([...facts.cloudfrontCachePaths].sort())) {
      findings.push(differs('cloudfrontCachePaths', facts.cloudfrontCachePaths.join(' ') || '(none)', paths.join(' ') || '(none)'));
    }
    if (ready !== undefined && ready !== 200) findings.push(differs('ready', '200', String(ready)));

    const tf = await attempt('terraform-since-applied', problems, () => sources.terraformFilesSince(facts.appliedCommit));
    if (tf?.truncated) problems.push('terraform-since-applied: truncated');
    else if (tf && tf.files.length > 0) {
      const listed = tf.files.slice(0, MAX_FILES_LISTED).map((f) => clean(f)).join(', ');
      findings.push(differs('terraform-unapplied', 'nothing merged after the applied commit', `${tf.files.length} file(s) under infrastructure/terraform/ changed: ${listed}`));
    }

    const behind = await attempt('image-behind-main', problems, () => sources.applicationChangeSince(facts.image.commit));
    if (behind?.since) {
      const days = (now.getTime() - Date.parse(behind.since)) / DAY_MS;
      if (days >= IMAGE_BEHIND_DAYS) {
        findings.push(differs('image-behind-main', `no application change older than ${IMAGE_BEHIND_DAYS} days`, `an application change merged ${Math.floor(days)} days ago is not in the running image`));
      }
    }

    const today = now.toISOString().slice(0, 10);
    for (const e of facts.acceptedExceptions) {
      if (e.reviewBy < today) findings.push(differs(`exception:${e.id}`, 'reviewed by its date', `review date ${clean(e.reviewBy, 10)} has passed: ${clean(e.reason, 120)}`));
    }
  }

  const complete = problems.length === 0;
  const result: Result = { complete, findings, problems };
  const outcome = complete ? 'complete' : 'incomplete';

  if (findings.length === 0 && complete) {
    console.log(`staging-freshness-ran outcome=complete findings=0 problems=0`);
    return result;
  }
  const subject = `Staging freshness:${findings.length ? ` ${findings.length} finding${findings.length === 1 ? '' : 's'}` : ''}${complete ? '' : `${findings.length ? ',' : ''} check incomplete`}`;
  const message = [
    ...findings.map((f) => `${f.field}\n  expected: ${f.expected}\n  live:     ${f.live}`),
    ...problems.map((p) => `could not read ${p.replace(/^([^:]+): (.*)$/, '$1 ($2)')}`),
    '',
    'Run scripts/staging/staging-status.sh for the full table. docs/ops/environments.md says what each field means.',
  ].join('\n');
  try {
    await sources.publish(subject, message);
  } catch (e) {
    // The email is the whole point: if it cannot be sent, the invocation fails (the Errors alarm) and the run is not counted complete.
    console.error(`staging-freshness-ran outcome=incomplete findings=${findings.length} problems=${problems.length + 1}`);
    throw e;
  }
  console.log(`staging-freshness-ran outcome=${outcome} findings=${findings.length} problems=${problems.length}`);
  return result;
}
