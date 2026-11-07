import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { BUNDLED_DRUG_LIST } from '@telesphoros/shared-types';
import { createTestApp, usingPostgres } from './helpers/app';
import { createEphemeralDatabase, type EphemeralDatabase, withAdmin } from './helpers/database';
import { LabPipeline } from './helpers/lab-pipeline';
import { bearer } from './helpers/tokens';
import { LedgerVerifier } from '../src/ledger/verifier';

(usingPostgres() ? describe : describe.skip)('medication fence local cutover: real in-flight transaction', () => {
  let db: EphemeralDatabase;
  let enabled: NestExpressApplication;
  let disabled: NestExpressApplication;
  let verifier: LedgerVerifier;
  beforeAll(async () => {
    db = await createEphemeralDatabase();
    enabled = await createTestApp({ postgresUrl: db.appUrl, medicationWrites: 'enabled' });
    disabled = await createTestApp({ postgresUrl: db.appUrl, medicationWrites: 'disabled' });
    verifier = LedgerVerifier.connect(db.verifierUrl);
  }, 60_000);
  afterAll(async () => {
    await verifier?.close();
    await enabled?.close();
    await disabled?.close();
    await db?.drop();
  });
  it('requires the old admitted write to finish before claiming the disabled replacement drained it', async () => {
    const old = new LabPipeline(enabled, db.adminUrl);
    const replacement = new LabPipeline(disabled, db.adminUrl, old.tenant);
    const clinician = await old.person('SYN-fence-cutover', ['clinician']);
    const patient = await old.patient(clinician);
    const payload = {
      requestId: randomUUID(),
      rxcui: '5470',
      listVersion: BUNDLED_DRUG_LIST!.version,
      status: 'active',
      source: 'clinician-entered',
      startMonth: '2026-01',
      stopMonth: null,
    };
    const blocker = new Client({ connectionString: db.adminUrl });
    await blocker.connect();
    let released = false;
    try {
      await blocker.query('BEGIN');
      await blocker.query('LOCK TABLE patient_medications IN SHARE MODE');
      // This real lock holds INSERT after the old API has already admitted the request.
      const inFlight = old
        .api()
        .post(`/api/v1/patients/${patient}/medications`)
        .set(bearer(clinician.token))
        .send(payload)
        .then(
          (response) => response,
          (error: unknown) => (error instanceof Error ? error : new Error('Synthetic request failed.')),
        );
      let waiting = false;
      for (let attempt = 0; attempt < 150; attempt += 1) {
        waiting = await withAdmin(db.adminUrl, async (client) =>
          Boolean(
            (
              await client.query("SELECT 1 FROM pg_stat_activity WHERE datname=$1 AND usename=$2 AND wait_event_type='Lock' AND query LIKE 'INSERT INTO patient_medications %'", [
                db.name,
                new URL(db.appUrl).username,
              ])
            ).rowCount,
          ),
        );
        if (waiting) break;
        await new Promise((resolve) => setTimeout(resolve, 10)); // Bounded polling of an observed lock, not a timing assumption.
      }
      expect(waiting).toBe(true);
      const refusal = await replacement
        .api()
        .post(`/api/v1/patients/${patient}/medications`)
        .set(bearer(clinician.token))
        .send({ ...payload, requestId: randomUUID() })
        .expect(503);
      expect(refusal.body.error.details[0].reason).toBe('medication-writes-fenced');
      expect(await old.count('patient_medications', 'patient_id=$1', [patient])).toBe(0);
      await blocker.query('COMMIT');
      released = true;
      const completed = await inFlight;
      if (completed instanceof Error) throw completed;
      expect(completed.status).toBe(201);
      expect(await old.count('patient_medications', 'patient_id=$1', [patient])).toBe(1);
      expect(await verifier.verify(old.tenant)).toMatchObject({ status: 'ok', eventsChecked: 1, failures: [] });
      await enabled.close(); // Retire the old process only after its admitted transaction finished.
      await replacement.api().post(`/api/v1/patients/${patient}/medications`).set(bearer(clinician.token)).send(payload).expect(503);
      const read = await replacement.api().get(`/api/v1/patients/${patient}/medications`).set(bearer(clinician.token)).expect(200);
      expect(read.body.items).toHaveLength(1);
      expect(read.body.items[0]).toMatchObject({ id: completed.body.id, version: 1 });
    } finally {
      if (!released) await blocker.query('ROLLBACK');
      await blocker.end();
    }
  });
});
