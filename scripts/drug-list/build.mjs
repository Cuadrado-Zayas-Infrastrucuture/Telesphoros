/** Build-time only; never receives patient data. Node 22, no dependencies. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { readFile, writeFile, open, unlink, rename } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = new URL('../../', import.meta.url);
const fda = JSON.parse(await readFile(new URL('packages/shared-types/src/drug-list/fda-tall-man.json', root), 'utf8'));
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
async function json(url) {
  // Node 22 fetch does not honor HTTPS_PROXY. curl keeps the runtime's proxy and CA trust without putting credentials in arguments.
  if (process.env.HTTPS_PROXY || process.env.https_proxy) {
    const {stdout} = await promisify(execFile)('curl',['--fail','--silent','--show-error','--location','--max-time','30','--proto','=https','--proto-redir','=https',url],{encoding:'utf8',maxBuffer:10*1024*1024});
    return JSON.parse(stdout);
  }
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000), headers: { accept: 'application/json' } });
  if (!response.ok) { await response.body?.cancel(); throw new Error(`Source request failed (${response.status}): ${new URL(url).hostname}`); }
  return response.json();
}
export async function build(get = json, now = new Date()) {
  const releaseUrl = 'https://api.github.com/repos/cpicpgx/cpic-data/releases/latest';
  const release = await get(releaseUrl);
  if (!/^v\d+\.\d+\.\d+$/.test(release.tag_name)) throw new Error('CPIC release metadata is missing.');
  const rx = await get('https://rxnav.nlm.nih.gov/REST/version.json');
  if (typeof rx.version !== 'string' || !rx.version) throw new Error('RxNorm release metadata is missing.');
  const source = 'https://api.cpicpgx.org/v1/drug';
  const rows = await get(source);
  const entries = [];
  const sourceProperties = [];
  for (const rxcui of candidates(rows)) {
    const data = await get(`https://rxnav.nlm.nih.gov/REST/rxcui/${rxcui}/properties.json`);
    // Empty properties means an obsolete/unavailable concept; it is excluded, never guessed or replaced.
    if (data.properties && data.properties.rxcui !== rxcui) throw new Error('RxNav returned a different code.');
    const entry = ingredient(rxcui, data.properties, rx.version);
    if (entry) {
      entries.push(entry);
      sourceProperties.push({rxcui:data.properties.rxcui,name:data.properties.name,tty:data.properties.tty});
    }
  }
  if (entries.length === 0) throw new Error('No verified ingredients; refusing to replace the bundled list.');
  if ((await get('https://rxnav.nlm.nih.gov/REST/version.json')).version !== rx.version || (await get(releaseUrl)).tag_name !== release.tag_name) {
    throw new Error('A source release changed during generation; retry.');
  }
  const content = {
    cpicRelease: release.tag_name,
    cpicSource: source,
    accessedAt: now.toISOString(),
    rxnormRelease: rx.version,
    attribution: 'This product uses publicly available data courtesy of the U.S. National Library of Medicine (NLM), National Institutes of Health, Department of Health and Human Services; NLM is not responsible for the product and does not endorse or recommend this or any other product.',
    currencyNotice: 'This bundled snapshot may not reflect the most current or accurate NLM data.',
    citations: [
      `${release.html_url}; API snapshot retrieved ${now.toISOString()}; associated release, not a pinned database export.`,
      'CPIC CC0 1.0; licensing confirmation from CPIC staff, 2026-08-31 (private founder-held email; do not publish the screenshot).',
      'https://cpicpgx.org/licensing/',
      'https://www.nlm.nih.gov/research/umls/rxnorm/docs/termsofservice.html',
      `${fda.source}; accessed ${fda.accessedAt}; FDA only, no ISMP-only entries.`,
    ],
    sourceProperties,
    entries: entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : a.rxcui.localeCompare(b.rxcui, 'en')),
  };
  return { status: 'verified', version: createHash('sha256').update(JSON.stringify(content)).digest('hex'), ...content };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const destination = new URL('packages/shared-types/src/drug-list/bundled.json', root);
  const lock = new URL('scripts/drug-list/.build.lock', root);
  let handle;
  try {
    handle = await open(lock, 'wx', 0o600);
    const result = await build();
    const temporary = new URL(`${destination.href}.tmp`);
    await writeFile(temporary, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' });
    await rename(temporary, destination);
    console.log(`Verified ${result.entries.length} ingredients; list ${result.version}.`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Drug-list build failed.');
    process.exitCode = 1;
  } finally {
    if (handle) { await handle.close(); await unlink(lock); }
  }
}
