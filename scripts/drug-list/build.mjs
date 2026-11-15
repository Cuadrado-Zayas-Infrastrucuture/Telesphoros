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
async function json(url) {
  for (let attempt = 0; ; attempt++) {
    try {
      // Node 22 fetch does not honor HTTPS_PROXY. curl keeps the runtime's proxy and CA trust without putting credentials in arguments.
      if (process.env.HTTPS_PROXY || process.env.https_proxy) {
        const {stdout} = await promisify(execFile)('curl',['--fail','--silent','--show-error','--location','--max-time','60','--proto','=https','--proto-redir','=https',url],{encoding:'utf8',maxBuffer:64*1024*1024});
        return JSON.parse(stdout);
      }
      const response = await fetch(url, { signal: AbortSignal.timeout(60_000), headers: { accept: 'application/json' } });
      if (!response.ok) { await response.body?.cancel(); throw new Error(`Source request failed (${response.status}): ${new URL(url).hostname}`); }
      return await response.json();
    } catch (error) {
      // Two bounded retries for a transient failure; a third failure refuses the whole artifact. Retries never substitute content.
      if (attempt >= 2) throw error;
      await new Promise((done) => setTimeout(done, 2_000 * (attempt + 1)));
    }
  }
}
/** At most `limit` requests in flight and one start every `spacingMs`: RxNav asks for no more than 20 requests per second per address. */
export async function mapLimited(items, worker, limit = 4, spacingMs = 75) {
  const results = new Array(items.length);
  let next = 0;
  let lastStart = 0;
  const lane = async () => {
    while (next < items.length) {
      const index = next++;
      const wait = lastStart + spacingMs - Date.now();
      lastStart = Math.max(Date.now(), lastStart + spacingMs);
      if (wait > 0) await new Promise((done) => setTimeout(done, wait));
      results[index] = await worker(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
  return results;
}
const byName = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.rxcui.localeCompare(b.rxcui, 'en'));
const byCode = (a, b) => a.rxcui.localeCompare(b.rxcui, 'en');
export async function build(get = json, now = new Date(), { spacingMs = 75, log = () => {} } = {}) {
  const releaseUrl = 'https://api.github.com/repos/cpicpgx/cpic-data/releases/latest';
  const release = await get(releaseUrl);
  if (!/^v\d+\.\d+\.\d+$/.test(release.tag_name)) throw new Error('CPIC release metadata is missing.');
  const rx = await get(`${RXNAV}/version.json`);
  if (typeof rx.version !== 'string' || !rx.version) throw new Error('RxNorm release metadata is missing.');
  const source = 'https://api.cpicpgx.org/v1/drug';
  const rows = await get(source);
  const listed = new Map();
  for (const rxcui of candidates(rows)) {
    const data = await get(`${RXNAV}/rxcui/${rxcui}/properties.json`);
    // Empty properties means an obsolete/unavailable concept; it is excluded, never guessed or replaced.
    if (data.properties && data.properties.rxcui !== rxcui) throw new Error('RxNav returned a different code.');
    if (ingredient(rxcui, data.properties, rx.version)) listed.set(rxcui, { rxcui, name: data.properties.name, tty: data.properties.tty });
  }
  const fromCpic = listed.size;
  for (const tty of ['IN', 'MIN']) {
    for (const concept of prescribableConcepts(await get(`${PRESCRIBABLE_SOURCE}?tty=${tty}`), tty)) {
      const known = listed.get(concept.rxcui);
      if (known && (known.name !== concept.name || known.tty !== concept.tty)) throw new Error('RxNav sources disagree on an ingredient name or type; retry.');
      if (!known) listed.set(concept.rxcui, concept);
    }
  }
  if (listed.size === 0) throw new Error('No verified ingredients; refusing to replace the bundled list.');
  const brands = prescribableConcepts(await get(`${PRESCRIBABLE_SOURCE}?tty=BN`), 'BN');
  const targets = await mapLimited(
    brands,
    async (brand) => brandTargets(await get(`${RXNAV}/Prescribe/rxcui/${brand.rxcui}/related.json?tty=IN+MIN`), listed),
    4,
    spacingMs,
  );
  const brandProperties = [];
  const brandsOf = new Map();
  brands.forEach((brand, index) => {
    if (!targets[index].length) return;
    brandProperties.push({ rxcui: brand.rxcui, name: brand.name, tty: 'BN', ingredients: targets[index] });
    for (const target of targets[index]) brandsOf.set(target, [...(brandsOf.get(target) ?? []), { rxcui: brand.rxcui, name: brand.name }]);
  });
  if ((await get(`${RXNAV}/version.json`)).version !== rx.version || (await get(releaseUrl)).tag_name !== release.tag_name) {
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
    const result = await build(json, new Date(), { log: (line) => console.log(line) });
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
