import { createHash, randomUUID } from 'node:crypto';
import { Database } from '../../src/db/database';
import { LedgerVerifier } from '../../src/ledger/verifier';
import { S3ObjectStorage } from '../../src/object-storage/s3-object-storage';
import { PostgresLedgerRecordsRepository } from '../../src/storage/postgres/ledger-records.repository';
import { PostgresReportsRepository } from '../../src/storage/postgres/reports.repository';
import type { ReportRecord } from '../../src/storage/records';
import { type EphemeralDatabase, withAdmin } from './database';
import { acceptanceFor, captureFor, evaluationFor, type SeededReport, sha } from './ledger-fixtures';

export const GENERATOR = { tenants: 3, coreRowsPerTenant: 100, uploadedPdfsPerTenant: 2, evaluationsPerCapture: 4, pdfBytes: 262144 };
export const EXPECTED_ROWS: Record<string, number> = {
  patients: 306, reports: 306, recommendations: 300, report_captures: 6, capture_acceptances: 6,
  evaluations: 24, evaluation_results: 72, evaluation_gene_states: 48, corrections: 12,
  cell_disputes: 6, cell_dispute_decisions: 3, ledger_checkpoints: 3, ledger_events: 60,
};

/** Valid one-page PDF, padded with PDF comments before its xref. No clinical or personal data. */
function syntheticPdf(index: number): Buffer {
  let body = '%PDF-1.4\n';
  const offsets = [0];
  const stream = `BT /F1 12 Tf 50 700 Td (Synthetic recovery fixture ${index}) Tj ET\n`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${stream.length} >>\nstream\n${stream}endstream`,
  ];
  objects.forEach((object, i) => { offsets.push(body.length); body += `${i + 1} 0 obj\n${object}\nendobj\n`; });
  // Fixed-width xref offset keeps the exact dataset size independent of object offsets.
  const trailerSize = 9 + 6 * 20 + '\ntrailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n'.length + 10 + '\n%%EOF\n'.length;
  body += '%' + 'x'.repeat(GENERATOR.pdfBytes - body.length - trailerSize - 2) + '\n';
  const xref = body.length;
  body += 'xref\n0 6\n0000000000 65535 f \n';
  body += offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  body += `\ntrailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${String(xref).padStart(10, '0')}\n%%EOF\n`;
  const bytes = Buffer.from(body, 'ascii');
  expect(bytes.length).toBe(GENERATOR.pdfBytes);
  return bytes;
}

export async function seedRecovery(pg: EphemeralDatabase, storage: S3ObjectStorage) {
  const database = new Database({ url: pg.appUrl, ssl: 'disable' });
  const reports = new PostgresReportsRepository(database);
  const repo = new PostgresLedgerRecordsRepository(database);
  const verifier = LedgerVerifier.connect(pg.verifierUrl);
  let firstCapture: { id: string; tenant: string } | undefined;
  try {
    for (let t = 0; t < GENERATOR.tenants; t++) {
      const tenant = `syn-recovery-${t}`;
      const disputeBasis: string[] = [];
      // Bulk core fixture; no uploaded bytes are claimed for these received metadata-only reports.
      await withAdmin(pg.adminUrl, async c => {
        for (let i = 0; i < GENERATOR.coreRowsPerTenant; i++) {
          const patient = randomUUID(); const report = randomUUID();
          await c.query('INSERT INTO patients (id,tenant_id,created_by,label) VALUES ($1,$2,$3,$4)', [patient, tenant, 'syn-uploader', `SYN-CORE-${i}`]);
          const requestId = i === 0 ? '3d100000-0000-4000-8000-000000000001' : null;
          const requestHash = requestId ? sha(JSON.stringify([patient, 'vcf', 'synthetic.vcf', 100])) : null;
          await c.query(`INSERT INTO reports (id,tenant_id,created_by,patient_id,type,original_filename,size_bytes,creation_request_id,creation_request_hash)
            VALUES ($1,$2,$3,$4,'vcf','synthetic.vcf',100,$5,$6)`, [report, tenant, 'syn-uploader', patient, requestId, requestHash]);
          await c.query(`INSERT INTO recommendations (tenant_id,created_by,patient_id,report_id,gene,drug,phenotype,summary,strength,guideline_version)
            VALUES ($1,$2,$3,$4,'SYN','syn-drug','synthetic','synthetic','Strong','syn-1')`, [tenant, 'syn-uploader', patient, report]);
        }
      });
      for (let p = 0; p < GENERATOR.uploadedPdfsPerTenant; p++) {
        const index = t * GENERATOR.uploadedPdfsPerTenant + p;
        const bytes = syntheticPdf(index); const hash = createHash('sha256').update(bytes).digest('hex');
        const patientId = randomUUID(); const reportId = randomUUID(); const key = `rehearsal/pdf-${index}.pdf`;
        await withAdmin(pg.adminUrl, c => c.query('INSERT INTO patients (id,tenant_id,created_by,label) VALUES ($1,$2,$3,$4)', [patientId, tenant, 'syn-uploader', `SYN-PDF-${p}`]));
        const record: ReportRecord = { id: reportId, tenantId: tenant, patientId, createdBy: 'syn-uploader', type: 'lab-pdf',
          filename: 'synthetic.pdf', sizeBytes: bytes.length, status: 'received', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
        await reports.insert(record);
        Object.assign(record, { sha256: hash, storageKey: key, contentType: 'application/pdf', uploadRequestedBy: 'syn-uploader' });
        expect(await reports.recordUploadRequest(record)).toBe(true);
        const uploaded = await storage.putObject(key, bytes, 'application/pdf');
        expect(uploaded.version).toBeTruthy();
        Object.assign(record, await reports.findById(tenant,reportId), { objectVersion: uploaded.version, uploadedAt: new Date().toISOString(), uploadedBy: 'syn-uploader' });
        expect(await reports.markUploaded(record)).toBe(true);
        // Latest bytes deliberately differ: recovery must read the pinned version, never latest.
        await storage.putObject(key, Buffer.from('Synthetic later version'), 'application/pdf');
        const r: SeededReport = { tenantId: tenant, uploader: 'syn-uploader', patientId, reportId, pdfSha256: hash, objectVersion: uploaded.version!, storageKey: key };
        const textKey = `rehearsal/text-${index}.txt`;
        await storage.putObject(textKey, Buffer.from('synthetic text'), 'text/plain');
        const capture = captureFor(r, 'synthetic text', { textStorageKey: textKey });
        const c = await repo.insertCapture(tenant, r.uploader, capture);
        firstCapture ??= { id: c.record.id, tenant };
        const a = await repo.insertAcceptance(tenant, 'syn-reviewer', acceptanceFor(c.record.id, capture));
        for (let e = 0; e < GENERATOR.evaluationsPerCapture; e++) {
          const evaluation = await repo.insertEvaluation(tenant, 'syn-system', evaluationFor(r, c.record.id, a.record.id, { knowledgeSetId: sha(`knowledge-${e}`), disputeBasis }));
          if (e === 0) {
            const correction = await repo.insertCorrection(tenant, 'syn-reviewer', { evaluationId: evaluation.record.id, kind: 'retraction', reasonCode: 'input-misread' });
            await repo.insertCorrection(tenant, 'syn-independent', { evaluationId: evaluation.record.id, kind: 'reinstatement', reasonCode: 'retraction-mistaken', previousCorrectionId: correction.record.id });
          }
        }
        const dispute = await repo.raiseDispute(tenant, 'syn-reviewer', { guidelineId: `syn-guideline-${index}`, guidelineVersion: '1', guidelineContentSha256: sha(`guideline-${index}`), locator: { table: 'synthetic', row: '1' }, note: 'Synthetic dispute' });
        disputeBasis.push(dispute.record.id);
        if (p === 0) await repo.decideDispute(tenant, 'syn-independent', { disputeId: dispute.record.id, decision: 'upheld', evidenceNote: 'Synthetic evidence' });
      }
      expect(await verifier.verify(tenant, { mode: 'full', recordCheckpoint: true })).toMatchObject({ status: 'ok' });
    }
    return firstCapture!;
  } finally { await verifier.close(); await database.onModuleDestroy(); }
}
