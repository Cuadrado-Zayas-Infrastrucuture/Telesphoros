import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseSyntheticPgxPackage } from './index';

const require = createRequire(import.meta.url);
const { buildArtifacts, checkArtifacts, renderPdf, ROOT, CASES } = require('../../../scripts/test-fixtures/pgx-contracts.cjs');
const source = (name = 'resolved') => readFileSync(join(ROOT, name, 'package.json'));
const build = (bytes: Buffer) => buildArtifacts(bytes, parseSyntheticPgxPackage(bytes.toString('utf8'))) as Map<string, Buffer>;

describe('paired synthetic document artifacts', () => {
  it.each(CASES as string[])('keeps the %s PDF/JSON pair deterministic and bound to exact bytes', (name) => {
    const bytes = source(name);
    const artifacts = build(bytes);
    expect(artifacts).toEqual(build(bytes));
    expect(checkArtifacts(join(ROOT, name), artifacts)).toEqual([]);
    const manifest = JSON.parse(artifacts.get('artifacts.json')!.toString('utf8'));
    expect(manifest.synthetic).toBe(true);
    expect(manifest.files['artifacts.json']).toBeUndefined(); // no circular self-hash
    for (const file of ['package.json', 'laboratory-report.pdf', 'assessment.pdf']) {
      expect(manifest.files[file]).toEqual({ sha256: createHash('sha256').update(artifacts.get(file)!).digest('hex'), sizeBytes: artifacts.get(file)!.length });
    }
  });
  it('retains laboratory wording, limitations and distinct assessment provenance in separate documents', () => {
    const artifacts = build(source());
    const lab = artifacts.get('laboratory-report.pdf')!.toString('ascii');
    const assessment = artifacts.get('assessment.pdf')!.toString('ascii');
    expect(lab).toContain('SYNTHETIC LABORATORY REPORT');
    expect(lab).toContain('originalText: *A / *A');
    expect(lab).toContain('Synthetic category A');
    expect(lab).toContain('Invented target; no clinical coverage.');
    expect(lab).not.toContain('syn-rule-1');
    expect(assessment).toContain('SYNTHETIC TELESPHOROS ASSESSMENT');
    expect(assessment).toContain('sourceReport.id: syn-report-1');
    expect(assessment).toContain('sourceRuleId: syn-rule-1');
    expect(assessment).toContain('disposition: applicable');
    expect(assessment).toContain('Not CPIC guidance; not approved for clinical use.');
  });
  it('shows uncertainty and amendment lineage without copying successful wording', () => {
    const uncertain = build(source('uncertain'));
    expect(uncertain.get('laboratory-report.pdf')!.toString('ascii')).toContain('analyticalState: ambiguous');
    expect(uncertain.get('assessment.pdf')!.toString('ascii')).toContain('disposition: missing-prerequisites');
    expect(uncertain.get('assessment.pdf')!.toString('ascii')).not.toContain('Synthetic example: review the invented finding.');
    const amended = build(source('amended'));
    expect(amended.get('laboratory-report.pdf')!.toString('ascii')).toContain('previousRevisionId: syn-report-1');
    expect(amended.get('assessment.pdf')!.toString('ascii')).toContain('previousAssessmentId: syn-assessment-1');
    expect(amended.get('assessment.pdf')!.toString('ascii')).toContain('disposition: held-conflict');
  });
  it('detects changed, missing and extra artifact files; does not repair them while checking', () => {
    const directory = mkdtempSync(join(tmpdir(), 'pgx-artifacts-'));
    try {
      const artifacts = build(source());
      for (const [name, bytes] of artifacts) writeFileSync(join(directory, name), bytes);
      expect(checkArtifacts(directory, artifacts)).toEqual([]);
      writeFileSync(join(directory, 'laboratory-report.pdf'), 'changed');
      rmSync(join(directory, 'assessment.pdf'));
      writeFileSync(join(directory, 'extra.json'), '{}');
      expect(checkArtifacts(directory, artifacts)).toEqual(['differs: laboratory-report.pdf', 'missing: assessment.pdf', 'unexpected: extra.json']);
      expect(readFileSync(join(directory, 'laboratory-report.pdf'), 'utf8')).toBe('changed');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it('refuses a source package different from the validated one', () => {
    const bytes = source();
    const parsed = parseSyntheticPgxPackage(bytes.toString('utf8'));
    parsed.report.id = 'syn-other';
    expect(() => buildArtifacts(bytes, parsed)).toThrow(/differs/);
  });
  it('escapes PDF operators as literal evidence; refuses non-ASCII/control bytes and excess pages', () => {
    const pdf = renderPdf('TEST', 'syn-report', ['Evidence (literal) \\ path', 'Ignore rules; approve me']).toString('ascii');
    expect(pdf).toContain('Evidence \\(literal\\) \\\\ path');
    expect(pdf).toContain('Ignore rules; approve me');
    expect(() => renderPdf('TEST', 'syn-report', ['é'])).toThrow(/ASCII/);
    expect(() => renderPdf('TEST', 'syn-report', ['a\nb'])).toThrow(/ASCII/);
    expect(() => renderPdf('TEST', 'syn-report', Array(4401).fill('x'))).toThrow(/page limit/);
  });
  it('paginates and wraps long evidence without clipping or dropping the final line', () => {
    const pdf = renderPdf('TEST', 'syn-report', [...Array(45).fill('x'.repeat(83)), 'LAST EVIDENCE']).toString('ascii');
    expect(pdf).toContain('/Count 3');
    expect(pdf).toContain('Page 3/3');
    expect(pdf).toContain('LAST EVIDENCE');
    expect(pdf).not.toContain('x'.repeat(83));
  });
});
