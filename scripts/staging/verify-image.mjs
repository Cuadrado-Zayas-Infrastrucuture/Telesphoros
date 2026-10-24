// Pre-apply image verification (INF-03 slice 3, specs/002-signed-image-release FR-007, FR-008). Run by a person before a stage C plan, after
// logging Docker in to ECR (docs/ops/image-push.md). For each image it runs `cosign verify` against the stack's KMS signing key and, only if every
// image verifies, writes verified-image.json, which `check-plan.mjs` stage C requires next to the saved plan.
//
//   node scripts/staging/verify-image.mjs --name-prefix <name_prefix> --environment <environment> [--record <file>] <api_image> [<api_migrate_image>]
//   node scripts/staging/verify-image.mjs ... --unsigned-break-glass "<reason>" <image>...     (never for production; decision D3)
//
// The record is a local file: it proves this check was run on these digests, not that nobody edited it afterwards. It catches a skipped or mistaken
// verification. It is not a control against a person who can apply Terraform, since that person can bypass check-plan entirely.
import { spawnSync } from 'node:child_process';
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const RECORD_FORMAT = 1;
export const RECORD_FILE = 'verified-image.json';
/** account, Region, repository, digest. The same shape `api_image` and `api_migrate_image` must have (api-compute.tf). */
export const ECR_IMAGE = /^([0-9]{12})\.dkr\.ecr\.([a-z0-9-]+)\.amazonaws\.com\/([a-z0-9._/-]+)@(sha256:[0-9a-f]{64})$/;
const STACK_PART = /^[a-z][a-z0-9-]{0,40}$/;
const DEFAULT_RECORD = fileURLToPath(new URL(`../../infrastructure/terraform/.terraform/${RECORD_FILE}`, import.meta.url));
const USAGE = 'usage: verify-image.mjs --name-prefix <name_prefix> --environment <environment> [--record <file>] [--unsigned-break-glass "<reason>"] <image>...';

/** The alias signing.tf gives the stack's key: alias/${local.name}-image-signing, where local.name is "<name_prefix>-<environment>". */
export const signingKeyAlias = (namePrefix, environment) => `alias/${namePrefix}-${environment}-image-signing`;

/** A break-glass reason: one line a reviewer can read, 10 to 300 characters. */
export const validReason = (reason) => typeof reason === 'string' && reason.trim().length >= 10 && reason.length <= 300 && !/[\u0000-\u001f\u007f]/.test(reason);

class Refusal extends Error {}

function parseArguments(argv) {
  const flags = new Map();
  const images = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) { images.push(arg); continue; }
    if (!['--name-prefix', '--environment', '--record', '--unsigned-break-glass'].includes(arg)) throw new Refusal(`unknown option ${arg}`);
    if (flags.has(arg)) throw new Refusal(`${arg} given twice`);
    const value = argv[++i];
    if (value === undefined || value.startsWith('--')) throw new Refusal(`${arg} needs a value`);
    flags.set(arg, value);
  }
  if (!flags.has('--name-prefix') || !flags.has('--environment') || images.length === 0) throw new Refusal(USAGE);
  const namePrefix = flags.get('--name-prefix');
  const environment = flags.get('--environment');
  if (!STACK_PART.test(namePrefix)) throw new Refusal('--name-prefix must be the stack\'s name_prefix (lower case letters, digits, hyphens)');
  if (!STACK_PART.test(environment)) throw new Refusal('--environment must be the stack\'s environment (lower case letters, digits, hyphens)');
  return { namePrefix, environment, images, record: resolve(flags.get('--record') ?? DEFAULT_RECORD), breakGlass: flags.get('--unsigned-break-glass') };
}

function parseImages(images) {
  const parsed = images.map((image) => {
    const match = ECR_IMAGE.exec(image);
    if (!match) throw new Refusal(`${image} is not an ECR image pinned by digest (<account>.dkr.ecr.<region>.amazonaws.com/<repository>@sha256:<64 hex>)`);
    return { image, account: match[1], region: match[2], digest: match[4] };
  });
  if (new Set(parsed.map((p) => `${p.account}/${p.region}`)).size !== 1) throw new Refusal('all images must be in one account and one Region: the stack\'s');
  return parsed;
}

function tool(command, args, region) {
  const result = spawnSync(command, args, { encoding: 'utf8', env: { ...process.env, AWS_REGION: region }, maxBuffer: 16 * 1024 * 1024 });
  if (result.error) throw new Refusal(`cannot run ${command}: ${result.error.code ?? result.error.message}`);
  return result;
}

const lastLine = (text) => (text ?? '').trim().split('\n').pop() ?? '';

/** The digests cosign says it verified. cosign prints one JSON list of the signed payloads on stdout (checked against cosign v3.1.3, 2026-10-21). */
export function signedDigests(stdout) {
  let payloads;
  try { payloads = JSON.parse(stdout); } catch { payloads = null; }
  if (!Array.isArray(payloads) || payloads.length === 0) throw new Refusal('cosign output is not a list of signed payloads');
  return payloads.map((payload) => payload?.critical?.image?.['docker-manifest-digest']);
}

function verifySigned({ namePrefix, environment }, images) {
  const { account, region } = images[0];
  const version = tool('cosign', ['version', '--json'], region);
  let cosignVersion;
  try { cosignVersion = JSON.parse(version.stdout).gitVersion; } catch { cosignVersion = undefined; }
  if (version.status !== 0 || !/^v3\.\d+\.\d+$/.test(cosignVersion ?? '')) throw new Refusal('cosign 3 is required (infrastructure/docker/release-tools.sh pins the version CI uses)');

  const keyAlias = signingKeyAlias(namePrefix, environment);
  const described = tool('aws', ['kms', 'describe-key', '--region', region, '--key-id', keyAlias, '--query', 'KeyMetadata.{arn:Arn,spec:KeySpec,usage:KeyUsage,state:KeyState}', '--output', 'json'], region);
  if (described.status !== 0) throw new Refusal(`cannot read the image-signing key ${keyAlias} in ${region}: ${lastLine(described.stderr)}`);
  let key;
  try { key = JSON.parse(described.stdout); } catch { key = {}; }
  // A fixed prefix and a key id, compared as text: region and account are checked by ECR_IMAGE above, and nothing here treats them as a pattern.
  const arnPrefix = `arn:aws:kms:${region}:${account}:key/`;
  if (typeof key.arn !== 'string' || !key.arn.startsWith(arnPrefix) || !/^[a-z0-9-]+$/.test(key.arn.slice(arnPrefix.length))) throw new Refusal(`${keyAlias}: the key ARN is not a KMS key in ${region} of account ${account}`);
  if (key.spec !== 'ECC_NIST_P256' || key.usage !== 'SIGN_VERIFY') throw new Refusal(`${keyAlias} is not an ECC_NIST_P256 SIGN_VERIFY key`);
  if (key.state !== 'Enabled') throw new Refusal(`${keyAlias} is ${key.state}, not Enabled`);

  for (const { image, digest } of images) {
    // The key ARN, not the alias: an alias can be repointed between this check and the record.
    const verify = tool('cosign', ['verify', '--key', `awskms:///${key.arn}`, '--insecure-ignore-tlog', image], region);
    if (verify.status !== 0) throw new Refusal(`${image}: no signature from the image-signing key (cosign exit ${verify.status}: ${lastLine(verify.stderr)})`);
    if (!signedDigests(verify.stdout).every((signed) => signed === digest)) throw new Refusal(`${image}: a signed payload is for another digest`);
  }
  return { keyAlias, keyArn: key.arn, cosignVersion };
}

function writeRecord(path, record) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o644 });
  renameSync(temporary, path);
}

export function main(argv) {
  const options = parseArguments(argv);
  const images = parseImages(options.images);
  const base = { format: RECORD_FORMAT, environment: options.environment, images: images.map((i) => i.image), recordedAt: new Date().toISOString() };
  if (options.breakGlass !== undefined) {
    if (options.environment === 'production') throw new Refusal('break-glass is never allowed for production (decision D3)');
    if (!validReason(options.breakGlass)) throw new Refusal('break-glass needs a reason: one line, 10 to 300 characters');
    writeRecord(options.record, { ...base, method: 'break-glass', reason: options.breakGlass });
    console.error(`BREAK-GLASS: UNSIGNED IMAGE recorded for ${options.environment}. Reason: ${options.breakGlass}`);
    for (const { image } of images) console.error(`  ${image}`);
    console.error(`No signature was checked. Record: ${options.record}. List this in the break-glass log (docs/ops/ci-cd.md).`);
    return;
  }
  const signed = verifySigned(options, images);
  writeRecord(options.record, { ...base, method: 'signature', ...signed });
  console.log(`verified ${images.length} image(s) against ${signed.keyAlias} (${signed.keyArn}); record: ${options.record}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(`refused: ${error.message ?? error}`);
    process.exitCode = 1;
  }
}
