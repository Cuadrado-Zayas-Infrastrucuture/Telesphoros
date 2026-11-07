// TEST ONLY: render already validated synthetic packages. No external input, network or clinical engine.
const { createHash } = require('node:crypto');
const { readFileSync, writeFileSync, readdirSync } = require('node:fs');
const { join, resolve } = require('node:path');
const { isDeepStrictEqual } = require('node:util');
const { buildPdf } = require('./lab-report-fixtures.cjs');
const ROOT = resolve(__dirname, '../../data/fixtures/pgx-contracts');
const CASES = ['resolved', 'uncertain', 'amended'];
const WIDTH = 82;
const BODY_LINES = 44;
const MAX_PAGES = 100;
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const escapePdf = (line) => line.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');

// Labels keep every field/value visible. No field selection can silently omit a limitation.
function flatten(value, prefix = '') {
  if (value === null) return [`${prefix}: null (not supplied / not applicable)`];
  if (typeof value !== 'object') return [`${prefix}: ${String(value)}`];
  const entries = Object.entries(value);
  if (entries.length === 0) return [`${prefix}: [] (no entries)`];
  return entries.flatMap(([key, item]) => flatten(item, prefix ? `${prefix}.${key}` : key));
}
function wrap(lines) {
  return lines.flatMap((line) => {
    // A built-in PDF font cannot encode arbitrary Unicode. Refuse it; never silently substitute bytes.
    if (!/^[\x20-\x7e]*$/.test(line)) throw new Error('Prototype PDF requires printable ASCII; the original JSON is unchanged.');
    const result = [];
    for (let offset = 0; offset < line.length; offset += WIDTH) result.push(line.slice(offset, offset + WIDTH));
    return result.length ? result : [''];
  });
}
function renderPdf(title, binding, body) {
  const lines = wrap(body);
  const count = Math.max(1, Math.ceil(lines.length / BODY_LINES));
  if (count > MAX_PAGES) throw new Error('Prototype PDF exceeds the page limit.');
  const pages = Array.from({ length: count }, (_, i) => [...wrap([title, binding]), `TEST ONLY - NOT FOR CLINICAL USE | Page ${i + 1}/${count}`, '', ...lines.slice(i * BODY_LINES, (i + 1) * BODY_LINES)]);
  if (pages.some((page) => page.length > 50)) throw new Error('Prototype PDF header exceeds the page bounds.');
  if (pages.length === 1) return buildPdf(pages[0]);
  // Same deterministic PDF 1.4/Courier representation as the existing single-page fixture helper.
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${pages.map((_, i) => `${4 + i * 2} 0 R`).join(' ')}] /Count ${pages.length} >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>',
  ];
  pages.forEach((page, i) => {
    const stream = `BT\n/F1 10 Tf\n14 TL\n40 750 Td\n${page.map((line) => `(${escapePdf(line)}) Tj T*`).join('\n')}\nET\n`;
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${5 + i * 2} 0 R /Resources << /Font << /F1 3 0 R >> >> >>`);
    objects.push(`<< /Length ${Buffer.byteLength(stream, 'ascii')} >>\nstream\n${stream}endstream`);
  });
  let output = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((object, i) => {
    offsets.push(Buffer.byteLength(output, 'ascii'));
    output += `${i + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(output, 'ascii');
  output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  output += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(output, 'ascii');
}

/** Caller must use parseSyntheticPgxPackage first. Pure renderer is exported only for fixture tests. */
function buildArtifacts(source, parsed) {
  if (!isDeepStrictEqual(JSON.parse(source.toString('utf8')), parsed)) throw new Error('Source JSON differs from the validated package.');
  const { report, assessment } = parsed;
  const files = new Map([['package.json', Buffer.from(source)]]);
  const binding = `Report ${report.id} | revision ${report.revision} | patient ${report.patientId}`;
  files.set('laboratory-report.pdf', renderPdf('SYNTHETIC LABORATORY REPORT', binding, [
    ...flatten({ schemaVersion: parsed.schemaVersion, synthetic: parsed.synthetic, clinicalUse: parsed.clinicalUse, actionable: parsed.actionable }),
    '', 'LABORATORY IDENTITY AND ORIGINAL FINDINGS', ...flatten(report),
  ]));
  if (assessment) files.set('assessment.pdf', renderPdf('SYNTHETIC TELESPHOROS ASSESSMENT', binding, [
    'Derived example; not authored by the laboratory.',
    ...flatten({ schemaVersion: parsed.schemaVersion, synthetic: parsed.synthetic, clinicalUse: parsed.clinicalUse, actionable: parsed.actionable }),
    '', 'ASSESSMENT, CONTEXT AND SYNTHETIC RULE SOURCES', ...flatten(assessment),
  ]));
  const manifest = {
    schemaVersion: 'pgx-artifacts-0.1', synthetic: true, reportId: report.id, revision: report.revision, assessmentId: assessment?.id ?? null,
    note: 'Hashes verify paired artifact bytes, not issuer identity, patient reconciliation or clinical validity.',
    files: Object.fromEntries([...files].map(([name, bytes]) => [name, { sha256: sha256(bytes), sizeBytes: bytes.length }])),
  };
  files.set('artifacts.json', Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`));
  return files;
}

function checkArtifacts(directory, expected) {
  const errors = [];
  for (const [name, bytes] of expected) {
    try { if (!readFileSync(join(directory, name)).equals(bytes)) errors.push(`differs: ${name}`); }
    catch { errors.push(`missing: ${name}`); }
  }
  for (const name of readdirSync(directory)) if (!expected.has(name)) errors.push(`unexpected: ${name}`);
  return errors;
}
module.exports = { buildArtifacts, checkArtifacts, renderPdf, CASES, ROOT };
if (require.main === module) {
  const { parseSyntheticPgxPackage } = require('../../packages/shared-types/dist/index.cjs');
  if (process.argv.slice(2).some((arg) => arg !== '--check')) throw new Error('Only --check is supported.');
  for (const name of CASES) {
    const directory = join(ROOT, name);
    const source = readFileSync(join(directory, 'package.json'));
    const artifacts = buildArtifacts(source, parseSyntheticPgxPackage(source.toString('utf8')));
    if (process.argv.includes('--check')) {
      const errors = checkArtifacts(directory, artifacts);
      if (errors.length) throw new Error(`${name}: ${errors.join(', ')}`);
    } else for (const [file, bytes] of artifacts) if (file !== 'package.json') writeFileSync(join(directory, file), bytes);
    process.stdout.write(`${name}: ${artifacts.size} paired artifacts ${process.argv.includes('--check') ? 'match' : 'written'}\n`);
  }
}
