import { CloudFrontClient, GetDistributionCommand } from '@aws-sdk/client-cloudfront';
import { CloudWatchClient, paginateDescribeAlarms } from '@aws-sdk/client-cloudwatch';
import { DescribeServicesCommand, DescribeTaskDefinitionCommand, ECSClient } from '@aws-sdk/client-ecs';
import { PublishCommand, SNSClient } from '@aws-sdk/client-sns';
import { type Facts, isTerraformInput, run, type Service, type Sources } from './handler';

/** The public repository this stack is built from. Read unauthenticated: a refusal makes the run incomplete, which emails the founder (spec 027, D3). */
const REPO = 'Cuadrado-Zayas-Infrastrucuture/Telesphoros';
/** Changes to any of these are changes to the running image; docs, specs, the vault and Terraform are not. */
const APPLICATION_PATHS = ['apps', 'packages', 'knowledge', 'infrastructure/docker', 'pnpm-lock.yaml'];
/** GitHub's compare answer holds 300 files at most; a full page may have more behind it. */
const COMPARE_FILE_LIMIT = 300;

class GithubError extends Error {
  override name = 'GithubError';
}

async function github<T>(path: string): Promise<T> {
  const res = await fetch(`https://api.github.com/repos/${REPO}/${path}`, {
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'telesphoros-staging-freshness' },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new GithubError(`github ${res.status}`);
  return (await res.json()) as T;
}

interface Compare {
  status: string;
  files?: { filename: string }[];
  commits?: { commit: { committer: { date: string } } }[];
}

const env = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not configured`);
  return value;
};

export function realSources(): Sources {
  const ecs = new ECSClient({});
  const cloudwatch = new CloudWatchClient({});
  const cloudfront = new CloudFrontClient({});
  const sns = new SNSClient({});
  const cluster = env('ECS_CLUSTER');
  const services = { api: env('API_SERVICE'), worker: env('WORKER_SERVICE') } as const;

  return {
    async facts() {
      const res = await fetch(`https://raw.githubusercontent.com/${REPO}/main/docs/ops/staging-expected.json`, { signal: AbortSignal.timeout(15_000) });
      if (!res.ok) throw new GithubError(`raw ${res.status}`);
      return (await res.json()) as Facts;
    },
    async service(name): Promise<Service> {
      const described = await ecs.send(new DescribeServicesCommand({ cluster, services: [services[name]] }));
      const arn = described.services?.[0]?.taskDefinition;
      const revision = Number(/:(\d+)$/.exec(arn ?? '')?.[1]);
      if (!arn || !Number.isInteger(revision)) throw new Error('NoTaskDefinition');
      const task = await ecs.send(new DescribeTaskDefinitionCommand({ taskDefinition: arn }));
      const image = task.taskDefinition?.containerDefinitions?.[0]?.image ?? '';
      const digest = image.split('@')[1];
      if (!digest) throw new Error('NoImageDigest');
      return { revision, digest };
    },
    async alarms() {
      let count = 0;
      for await (const page of paginateDescribeAlarms({ client: cloudwatch }, { AlarmNamePrefix: env('ALARM_PREFIX'), AlarmTypes: ['MetricAlarm'] })) count += page.MetricAlarms?.length ?? 0;
      return count;
    },
    async cloudfrontPaths() {
      const out = await cloudfront.send(new GetDistributionCommand({ Id: env('DISTRIBUTION_ID') }));
      return out.Distribution?.DistributionConfig?.CacheBehaviors?.Items?.map((b) => b.PathPattern ?? '') ?? [];
    },
    async ready() {
      const res = await fetch(env('READY_URL'), { signal: AbortSignal.timeout(10_000) });
      return res.status;
    },
    async terraformFilesSince(commit) {
      const compare = await github<Compare>(`compare/${commit}...main`);
      if (compare.status !== 'ahead' && compare.status !== 'identical') throw new GithubError('applied commit is not an ancestor of main');
      const all = compare.files ?? [];
      return { files: all.map((f) => f.filename).filter(isTerraformInput), truncated: all.length >= COMPARE_FILE_LIMIT };
    },
    async applicationChangeSince(commit) {
      const compare = await github<Compare>(`compare/${commit}...main`);
      const all = compare.files ?? [];
      if (all.length >= COMPARE_FILE_LIMIT) throw new GithubError('compare truncated');
      const changed = all.some((f) => APPLICATION_PATHS.some((p) => f.filename === p || f.filename.startsWith(`${p}/`)));
      if (!changed) return { since: undefined };
      const image = await github<{ commit: { committer: { date: string } } }>(`commits/${commit}`);
      const dates: string[] = [];
      for (const path of APPLICATION_PATHS) {
        const list = await github<{ sha: string; commit: { committer: { date: string } } }[]>(`commits?sha=main&path=${encodeURIComponent(path)}&since=${encodeURIComponent(image.commit.committer.date)}&per_page=100`);
        dates.push(...list.filter((c) => c.sha !== commit).map((c) => c.commit.committer.date));
      }
      // No path-filtered commit found although the files differ (a rewritten history): fall back to the first commit after the image.
      const fallback = compare.commits?.[0]?.commit.committer.date;
      const earliest = [...dates, ...(dates.length === 0 && fallback ? [fallback] : [])].sort()[0];
      return { since: earliest };
    },
    async publish(subject, message) {
      await sns.send(new PublishCommand({ TopicArn: env('TOPIC_ARN'), Subject: subject.slice(0, 99), Message: message }));
    },
  };
}

export const handler = async (): Promise<{ complete: boolean; findings: number; problems: number }> => {
  const result = await run(realSources());
  return { complete: result.complete, findings: result.findings.length, problems: result.problems.length };
};
