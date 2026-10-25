import { Client } from 'pg';
import { EvidenceError, parse, referenceSchema, type EvidenceReference } from './evidence-catalogue';
import type { EvidenceBudget } from './evidence-storage';
import { pgClientConfig } from './tls';

export interface EvidenceInventory {
  references: EvidenceReference[];
  uncompletedRegistrations: number;
  restoredDatabaseBytes: number;
}
/** Called inside restoreAndVerify's successful callback. This helper alone is NOT a verification certificate. */
export async function readEvidenceInventory(url: string, budget: EvidenceBudget): Promise<EvidenceInventory> {
  const client = new Client({ ...pgClientConfig(url), connectionTimeoutMillis: budget.remainingMs(), query_timeout: budget.remainingMs() });
  const references: EvidenceReference[] = [];
  let uncompletedRegistrations = 0;
  const add = (raw: unknown) => {
    budget.check();
    if (references.length >= budget.limits.references) throw new EvidenceError('limit');
    references.push(parse(referenceSchema, raw));
  };
  try {
    await client.connect();
    const role = await client.query<{ ok: boolean }>('SELECT (rolsuper OR rolbypassrls) AS ok FROM pg_roles WHERE rolname=current_user');
    if (!role.rows[0]?.ok) throw new EvidenceError('inventory');
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await client.query("SELECT set_config('statement_timeout', $1, true)", [String(budget.limits.requestMs)]);
    const tenants = await client.query<{ tenant_id: string }>(
      'SELECT tenant_id FROM (SELECT tenant_id FROM reports UNION SELECT tenant_id FROM report_captures) AS tenants ORDER BY tenant_id LIMIT $1',
      [budget.limits.references + 1],
    );
    if (tenants.rows.length > budget.limits.references) throw new EvidenceError('limit');
    for (const { tenant_id: tenant } of tenants.rows) {
      budget.check();
      const incomplete = await client.query<{ n: string }>('SELECT count(*)::text AS n FROM reports WHERE tenant_id=$1 AND uploaded_at IS NULL', [tenant]);
      uncompletedRegistrations += Number(incomplete.rows[0].n);
      if (!Number.isSafeInteger(uncompletedRegistrations)) throw new EvidenceError('limit');
      let seq = '0';
      for (;;) {
        budget.check();
        const page = await client.query(
          'SELECT seq::text, id, type, storage_key, object_version, sha256, size_bytes::text, content_type FROM reports WHERE tenant_id=$1 AND uploaded_at IS NOT NULL AND seq>$2::bigint ORDER BY reports.seq LIMIT $3',
          [tenant, seq, 100],
        );
        for (const row of page.rows)
          add({
            tenantId: tenant,
            reportId: row.id,
            captureId: null,
            kind: row.type,
            key: row.storage_key,
            dbVersion: row.object_version,
            sha256: row.sha256,
            sizeBytes: Number(row.size_bytes),
            contentType: row.content_type,
            scalars: null,
            runner: null,
            popplerVersion: null,
          });
        if (page.rows.length < 100) break;
        seq = page.rows.at(-1)!.seq;
      }
      seq = '0';
      for (;;) {
        budget.check();
        const page = await client.query(
          'SELECT c.seq::text, c.id, c.report_id, c.pdf_sha256, c.text_storage_key, c.text_sha256, c.text_scalars, c.runner, c.poppler_version, r.sha256 AS report_hash, r.uploaded_at, r.object_version FROM report_captures c LEFT JOIN reports r ON r.tenant_id=c.tenant_id AND r.id=c.report_id WHERE c.tenant_id=$1 AND c.seq>$2::bigint ORDER BY c.seq LIMIT $3',
          [tenant, seq, 100],
        );
        for (const row of page.rows) {
          if (!row.uploaded_at || !row.object_version || row.pdf_sha256 !== row.report_hash) throw new EvidenceError('inventory');
          add({
            tenantId: tenant,
            reportId: row.report_id,
            captureId: row.id,
            kind: 'text',
            key: row.text_storage_key,
            dbVersion: null,
            sha256: row.text_sha256,
            sizeBytes: null,
            contentType: 'text/plain; charset=utf-8',
            scalars: row.text_scalars,
            runner: row.runner,
            popplerVersion: row.poppler_version,
          });
        }
        if (page.rows.length < 100) break;
        seq = page.rows.at(-1)!.seq;
      }
    }
    const physical = await client.query<{ n: string }>('SELECT pg_database_size(current_database())::text AS n');
    const restoredDatabaseBytes = Number(physical.rows[0].n);
    if (!Number.isSafeInteger(restoredDatabaseBytes)) throw new EvidenceError('limit');
    await client.query('COMMIT');
    budget.check();
    return { references, uncompletedRegistrations, restoredDatabaseBytes };
  } catch (error) {
    if (error instanceof EvidenceError) throw error;
    throw new EvidenceError('inventory');
  } finally {
    await client.end();
  }
}
