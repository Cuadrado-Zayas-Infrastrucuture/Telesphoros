// Builds the public synthetic lab-report fixtures in data/fixtures/lab-reports/captures (TEST ONLY).
//
//   node scripts/test-fixtures/lab-report-fixtures.cjs           write the fixtures
//   node scripts/test-fixtures/lab-report-fixtures.cjs --check   exit 1 if what is on disk differs from what this script builds
//
// These are original, synthetic documents written for this repository. They are not copies of, and not derived from, any laboratory report
// or from the files of the imported reader engine. Their ids (D01, D02, D08) match the hand-written expectations in
// tests/report_adapter/golden.json on purpose, so the same oracle serves the engine's twelve development reports (kept private) and these.
// The bytes are deterministic: no dates, no random ids, so the generated hashes never change unless the content here does.
const { createHash } = require('node:crypto');
const { mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync } = require('node:fs');
const { join, resolve } = require('node:path');

const ROOT = resolve(__dirname, '../..');
const TARGET = join(ROOT, 'data/fixtures/lab-reports/captures');
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

const HEADER = ['SYNTHETIC PHARMACOGENOMIC REPORT - TEST ONLY', 'Written for this repository. Not a laboratory report and not clinical content.'];

/** The lines of each report. The format is the one the test stand-in reader understands (apps/backend/test/helpers/stand-in-reader.ts). */
const REPORTS = {
  // Two genes, each with a diplotype the test tables map and a reported result that agrees with that mapping.
  D01: [
    ...HEADER,
    'Report: D01 | Specimen: synthetic',
    'Gene: CYP2C19 | Diplotype: *1/*2 | Result: Intermediate Metabolizer',
    'Gene: CYP2B6 | Diplotype: *1/*1 | Result: Normal Metabolizer',
    'End of synthetic report.',
  ],
  // One gene whose second allele the test tables do not define: the engine must say so rather than guess.
  D02: [
    ...HEADER,
    'Report: D02 | Specimen: synthetic',
    'Gene: CYP2C19 | Diplotype: *1/*Z | Result: Normal Metabolizer',
    'End of synthetic report.',
  ],
  // A column table the reader cannot align: the whole report is held, with a named reason.
  D08: [
    ...HEADER,
    'Report: D08 | Specimen: synthetic',
    'Layout: unaligned-columns',
    'Gene: CYP2C19 | Diplotype: *1/*2 | Result: Intermediate Metabolizer',
    'End of synthetic report.',
  ],
};

const escapePdf = (line) => line.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');

/** A one-page PDF 1.4 holding the lines, in a built-in font. Deterministic: no /ID, no dates, fixed object order. */
function buildPdf(lines) {
  const stream = `BT\n/F1 10 Tf\n14 TL\n40 750 Td\n${lines.map((line) => `(${escapePdf(line)}) Tj T*`).join('\n')}\nET\n`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}endstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out, 'latin1'));
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

/** The files of every fixture, by relative path. Each report: source.pdf, report.txt and capture.json (the manifest the recorded-text runner checks). */
function build() {
  const files = new Map();
  for (const [id, lines] of Object.entries(REPORTS)) {
    const pdf = buildPdf(lines);
    const text = Buffer.from(`${lines.join('\n')}\n`, 'utf8');
    const manifest = {
      id,
      synthetic: true,
      note: 'Original synthetic fixture written for this repository; the text is recorded, not extracted from the PDF.',
      source_pdf_sha256: sha256(pdf),
      stored_text_sha256: sha256(text),
      extractor: { name: 'recorded text (no extraction)', version: 'recorded to model pdftotext 26.03.0' },
    };
    files.set(`${id}/source.pdf`, pdf);
    files.set(`${id}/report.txt`, text);
    files.set(`${id}/capture.json`, Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8'));
  }
  return files;
}

function check(files) {
  const problems = [];
  for (const [path, bytes] of files) {
    const file = join(TARGET, path);
    if (!existsSync(file)) problems.push(`missing: ${path}`);
    else if (!readFileSync(file).equals(bytes)) problems.push(`differs: ${path}`);
  }
  if (existsSync(TARGET)) {
    for (const dir of readdirSync(TARGET)) if (!(dir in REPORTS)) problems.push(`unexpected fixture directory: ${dir}`);
  }
  return problems;
}

function write(files) {
  for (const [path, bytes] of files) {
    const file = join(TARGET, path);
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, bytes);
  }
}

module.exports = { build, check, write, REPORTS, TARGET, buildPdf };

if (require.main === module) {
  const files = build();
  if (process.argv.includes('--check')) {
    const problems = check(files);
    if (problems.length > 0) {
      process.stderr.write(`${problems.join('\n')}\nRun: node scripts/test-fixtures/lab-report-fixtures.cjs\n`);
      process.exit(1);
    }
    process.stdout.write(`${files.size} files match.\n`);
  } else {
    write(files);
    process.stdout.write(`Wrote ${files.size} files under data/fixtures/lab-reports/captures.\n`);
  }
}
