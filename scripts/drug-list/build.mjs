/** Build-time only; never receives patient data. Node 22, no dependencies. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { readFile, writeFile, open, unlink, rename } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = new URL('../../', import.meta.url);
const fda = JSON.parse(await readFile(new URL('packages/shared-types/src/drug-list/fda-tall-man.json', root), 'utf8'));
const RXNAV = 'https://rxnav.nlm.nih.gov/REST';
// RxNorm Current Prescribable Content: SAB=RXNORM and MTHSPL only, published by NLM without licensing restrictions.
export const PRESCRIBABLE_SOURCE = `${RXNAV}/Prescribe/allconcepts.json`;
/**
 * The longest name a record can store: the shared schema and the `patient_medications.drug_name` CHECK both cap it at 300. On
 * 2026-11-14 the only longer prescribable names were 17 multi-antigen vaccines (308 to 2,115 characters); the founder chose to leave
 * them out rather than widen the column. They and any brand that points only to them are printed, never shortened.
 */
export const MAX_NAME = 300;
export function candidates(rows) {
  if (!Array.isArray(rows) || rows.length === 0) throw new Error('CPIC returned no drug rows.');
  return [...new Set(rows.map((row) => /^RxNorm:([1-9][0-9]*)$/.exec(row.drugid ?? '')?.[1]).filter(Boolean))].sort();
}
export function ingredient(rxcui, properties, rxnormRelease) {
  if (!properties || properties.rxcui !== rxcui || !['IN', 'MIN'].includes(properties.tty)) return null;
  if (typeof properties.name !== 'string' || !properties.name.trim()) throw new Error('RxNav returned an ingredient without a canonical name.');
  const name = properties.name;
  return { rxcui, name, displayName: fda.names.find((form) => form.toLowerCase() === name.toLowerCase()) ?? name, tty: properties.tty, rxnormRelease };
}
/** Rows of one prescribable term type. A malformed row refuses the build; it is never skipped or repaired. */
export function prescribableConcepts(data, tty) {
  const rows = data?.minConceptGroup?.minConcept;
  if (!Array.isArray(rows) || rows.length === 0) throw new Error(`RxNav returned no prescribable ${tty} concepts.`);
  return rows.map((row) => {
    if (!/^[1-9][0-9]*$/.test(row?.rxcui ?? '') || row.tty !== tty || typeof row.name !== 'string' || !row.name.trim()) {
      throw new Error(`RxNav returned a malformed prescribable ${tty} concept.`);
    }
    return { rxcui: row.rxcui, name: row.name, tty: row.tty };
  });
}
/**
 * Which listed ingredient(s) a brand name points to. A brand is a search alias only: records keep the ingredient code.
 * Combination brands go to their multiple-ingredient concept(s) (MIN); a single-ingredient brand goes to its one IN.
 * A brand with several ingredients and no MIN is ambiguous and is left out, never guessed.
 */
export function brandTargets(related, listed) {
  const groups = related?.relatedGroup?.conceptGroup;
  if (!Array.isArray(groups)) throw new Error('RxNav returned no related-concept groups for a brand.');
  const of = (tty) =>
    [...new Set(groups.filter((group) => group.tty === tty).flatMap((group) => group.conceptProperties ?? []).map((concept) => concept.rxcui))].filter((rxcui) => listed.has(rxcui));
  const combinations = of('MIN');
  if (combinations.length) return combinations.sort();
  const singles = of('IN');
  return singles.length === 1 ? singles : [];
}
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
/**
 * One shared start schedule for every request to a host, across all lanes. RxNav publishes a limit of 20 requests per second per address
 * and answered 429 to a 2026-11-14 run that paced only the brand phase, so every RxNav request is paced well below it. A 429 pushes the
 * whole schedule back and slows it, so the other lanes wait too instead of hammering a throttled server.
 */
export function createPacer(spacingMs, maxSpacingMs = 2_000) {
  let next = 0;
  let spacing = spacingMs;
  return {
    get spacingMs() { return spacing; },
    async turn() {
      const start = Math.max(Date.now(), next);
      next = start + spacing;
      if (start > Date.now()) await sleep(start - Date.now());
    },
    slowDown(pauseMs) {
      next = Math.max(next, Date.now() + pauseMs);
      spacing = Math.min(maxSpacingMs, Math.max(spacing * 2, 1));
    },
  };
}
class SourceError extends Error {
  constructor(status, host, retryAfterMs) {
    super(`Source request failed (${status}): ${host}`);
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}
const retryAfter = (value) => (value && /^\d+$/.test(value.trim()) ? Number(value.trim()) * 1_000 : undefined);
async function request(url) {
  // Node 22 fetch does not honor HTTPS_PROXY. curl keeps the runtime's proxy and CA trust without putting credentials in arguments.
  if (process.env.HTTPS_PROXY || process.env.https_proxy) {
    try {
      const {stdout} = await promisify(execFile)('curl',['--fail','--silent','--show-error','--location','--max-time','60','--proto','=https','--proto-redir','=https',url],{encoding:'utf8',maxBuffer:64*1024*1024});
      return JSON.parse(stdout);
    } catch (error) {
      const status = /returned error: (\d{3})/.exec(String(error?.stderr ?? ''))?.[1];
      if (status) throw new SourceError(Number(status), new URL(url).hostname);
      throw error;
    }
  }
  const response = await fetch(url, { signal: AbortSignal.timeout(60_000), headers: { accept: 'application/json' } });
  if (!response.ok) {
    await response.body?.cancel();
    throw new SourceError(response.status, new URL(url).hostname, retryAfter(response.headers.get('retry-after')));
  }
  return response.json();
}
/**
 * Bounded retries; the last failure refuses the whole artifact, and a retry never substitutes content. A throttled answer (429, 503)
 * waits for Retry-After or a growing pause (5, 10, 20, 40, 60 s) and slows the shared schedule; any other failure gets two quick retries.
 */
export async function fetchWithRetry(url, { pacer, send = request, pause = sleep, throttleBaseMs = 5_000, onThrottle = () => {} } = {}) {
  for (let attempt = 0; ; attempt++) {
    await pacer?.turn();
    try {
      return await send(url);
    } catch (error) {
      const throttled = error?.status === 429 || error?.status === 503;
      if (attempt >= (throttled ? 5 : 2)) throw error;
      const wait = throttled ? Math.max(error.retryAfterMs ?? 0, Math.min(60_000, throttleBaseMs * 2 ** attempt)) : 2_000 * (attempt + 1);
      if (throttled) {
        pacer?.slowDown(wait);
        onThrottle(wait, new URL(url).hostname);
      }
      await pause(wait);
    }
  }
}
/** At most `limit` requests in flight; their start times come from the shared pacer inside `worker`. Results keep input order. */
export async function mapLimited(items, worker, limit = 2) {
  const results = new Array(items.length);
  let next = 0;
  const lane = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await worker(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
  return results;
}
/** Names the phase that failed, so a refused run says where it stopped. */
const phase = async (name, work) => {
  try {
    return await work();
  } catch (error) {
    throw new Error(`${name}: ${error instanceof Error ? error.message : 'failed'}`);
  }
};
const byName = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.rxcui.localeCompare(b.rxcui, 'en'));
const byCode = (a, b) => a.rxcui.localeCompare(b.rxcui, 'en');
/** Every RxNav request shares one pacer (about 8 per second); other hosts get the same retries without pacing. */
export function sourceGetter(spacingMs = 125, log = () => {}) {
  const pacer = createPacer(spacingMs);
  const onThrottle = (wait, host) => log(`  ${host} asked to slow down; pausing ${Math.round(wait / 1_000)} s, then one request every ${pacer.spacingMs} ms.`);
  return (url) => fetchWithRetry(url, { pacer: new URL(url).hostname === new URL(RXNAV).hostname ? pacer : undefined, onThrottle });
}
export async function build(get = sourceGetter(), now = new Date(), { log = () => {} } = {}) {
  const releaseUrl = 'https://api.github.com/repos/cpicpgx/cpic-data/releases/latest';
  const { release, rx, rows } = await phase('release metadata and CPIC drug table', async () => {
    const release = await get(releaseUrl);
    if (!/^v\d+\.\d+\.\d+$/.test(release.tag_name)) throw new Error('CPIC release metadata is missing.');
    const rx = await get(`${RXNAV}/version.json`);
    if (typeof rx.version !== 'string' || !rx.version) throw new Error('RxNorm release metadata is missing.');
    return { release, rx, rows: await get('https://api.cpicpgx.org/v1/drug') };
  });
  const source = 'https://api.cpicpgx.org/v1/drug';
  const listed = new Map();
  const cpicCodes = candidates(rows);
  await phase('CPIC ingredient check at RxNav', async () => {
    for (const rxcui of cpicCodes) {
      const data = await get(`${RXNAV}/rxcui/${rxcui}/properties.json`);
      // Empty properties means an obsolete/unavailable concept; it is excluded, never guessed or replaced.
      if (data.properties && data.properties.rxcui !== rxcui) throw new Error('RxNav returned a different code.');
      if (ingredient(rxcui, data.properties, rx.version)) listed.set(rxcui, { rxcui, name: data.properties.name, tty: data.properties.tty });
    }
  });
  const fromCpic = listed.size;
  log(`${fromCpic} of ${cpicCodes.length} CPIC codes verified as ingredients.`);
  const tooLong = [];
  await phase('prescribable ingredients', async () => {
    for (const tty of ['IN', 'MIN']) {
      for (const concept of prescribableConcepts(await get(`${PRESCRIBABLE_SOURCE}?tty=${tty}`), tty)) {
        const known = listed.get(concept.rxcui);
        if (known && (known.name !== concept.name || known.tty !== concept.tty)) throw new Error('RxNav sources disagree on an ingredient name or type; retry.');
        if (known) continue;
        if (concept.name.length > MAX_NAME) tooLong.push(concept);
        else listed.set(concept.rxcui, concept);
      }
    }
  });
  if (listed.size === 0) throw new Error('No verified ingredients; refusing to replace the bundled list.');
  if (tooLong.length) {
    log(`${tooLong.length} prescribable names over ${MAX_NAME} characters left out:`);
    for (const concept of tooLong.sort(byCode)) log(`  ${concept.rxcui} (${concept.name.length} characters) ${concept.name.slice(0, 60)}...`);
  }
  const allBrands = await phase('prescribable brand names', async () => prescribableConcepts(await get(`${PRESCRIBABLE_SOURCE}?tty=BN`), 'BN'));
  const brands = allBrands.filter((brand) => brand.name.length <= MAX_NAME);
  if (brands.length < allBrands.length) log(`${allBrands.length - brands.length} brand names over ${MAX_NAME} characters left out.`);
  log(`${listed.size} ingredients listed; mapping ${brands.length} brand names (one RxNav request each).`);
  let done = 0;
  const targets = await phase('brand-to-ingredient mapping', () =>
    mapLimited(brands, async (brand) => {
      const result = brandTargets(await get(`${RXNAV}/Prescribe/rxcui/${brand.rxcui}/related.json?tty=IN+MIN`), listed);
      if (++done % 500 === 0) log(`  brands ${done}/${brands.length}`);
      return result;
    }),
  );
  const brandProperties = [];
  const brandsOf = new Map();
  brands.forEach((brand, index) => {
    if (!targets[index].length) return;
    brandProperties.push({ rxcui: brand.rxcui, name: brand.name, tty: 'BN', ingredients: targets[index] });
    for (const target of targets[index]) brandsOf.set(target, [...(brandsOf.get(target) ?? []), { rxcui: brand.rxcui, name: brand.name }]);
  });
  const [rxAfter, releaseAfter] = await phase('release recheck', async () => [await get(`${RXNAV}/version.json`), await get(releaseUrl)]);
  if (rxAfter.version !== rx.version || releaseAfter.tag_name !== release.tag_name) {
    throw new Error('A source release changed during generation; retry.');
  }
  const sourceProperties = [...listed.values()].sort(byCode);
  const entries = sourceProperties.map((properties) => {
    const entry = ingredient(properties.rxcui, properties, rx.version);
    const aliases = (brandsOf.get(properties.rxcui) ?? []).sort(byName);
    return aliases.length ? { ...entry, brands: aliases } : entry;
  });
  log(
    `${fromCpic} CPIC ingredients, ${listed.size - fromCpic} added from prescribable content; ` +
      `${brandProperties.length} of ${brands.length} brand names mapped, ${brands.length - brandProperties.length} left out (ambiguous or no listed ingredient).`,
  );
  const content = {
    cpicRelease: release.tag_name,
    cpicSource: source,
    prescribableSource: PRESCRIBABLE_SOURCE,
    accessedAt: now.toISOString(),
    rxnormRelease: rx.version,
    attribution: 'This product uses publicly available data courtesy of the U.S. National Library of Medicine (NLM), National Institutes of Health, Department of Health and Human Services; NLM is not responsible for the product and does not endorse or recommend this or any other product.',
    currencyNotice: 'This bundled snapshot may not reflect the most current or accurate NLM data.',
    citations: [
      `${release.html_url}; API snapshot retrieved ${now.toISOString()}; associated release, not a pinned database export.`,
      'CPIC CC0 1.0; licensing confirmation from CPIC staff, 2026-08-31 (private founder-held email; do not publish the screenshot).',
      'https://cpicpgx.org/licensing/',
      `https://www.nlm.nih.gov/research/umls/rxnorm/docs/prescribe.html; RxNorm Current Prescribable Content (SAB=RXNORM and MTHSPL), provided by NLM without licensing restrictions; API snapshot retrieved ${now.toISOString()}.`,
      'https://www.nlm.nih.gov/research/umls/rxnorm/docs/termsofservice.html',
      `${fda.source}; accessed ${fda.accessedAt}; FDA only, no ISMP-only entries.`,
    ],
    sourceProperties,
    brandProperties: brandProperties.sort(byCode),
    entries: entries.sort(byName),
  };
  return { status: 'verified', version: createHash('sha256').update(JSON.stringify(content)).digest('hex'), ...content };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const destination = new URL('packages/shared-types/src/drug-list/bundled.json', root);
  const lock = new URL('scripts/drug-list/.build.lock', root);
  let handle;
  try {
    handle = await open(lock, 'wx', 0o600);
    const log = (line) => console.log(line);
    const result = await build(sourceGetter(125, log), new Date(), { log });
    const temporary = new URL(`${destination.href}.tmp`);
    await writeFile(temporary, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' });
    await rename(temporary, destination);
    console.log(`Verified ${result.entries.length} ingredients and ${result.brandProperties.length} brand names; list ${result.version}.`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Drug-list build failed.');
    process.exitCode = 1;
  } finally {
    if (handle) { await handle.close(); await unlink(lock); }
  }
}
