import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { startFakeIdp, type FakeIdp } from '@telesphoros/fake-idp';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { createTestApp, usingPostgres } from './helpers/app';
import { createEphemeralDatabase, type EphemeralDatabase } from './helpers/database';
import { fixturePdf, LabPipeline } from './helpers/lab-pipeline';
import { CognitoTokenVerifier } from '../src/auth/cognito-token-verifier';
import { bearer } from './helpers/tokens';
import { BUNDLED_DRUG_LIST } from '@telesphoros/shared-types';
import { LedgerVerifier } from '../src/ledger/verifier';

// Explicit browser tier. Uses the existing PostgreSQL fixture harness; the reader and recorded-text
// runner remain its test-only substitutes. This cannot establish that a product extraction engine exists.
(usingPostgres() && process.env.DECISION_BROWSER === '1' ? describe : describe.skip)('patient decision browser workflow', () => {
  it('runs the real patient UI against PostgreSQL-backed decision and follow-up APIs', async () => {
    let db: EphemeralDatabase | undefined;
    let app: NestExpressApplication | undefined;
    let idp: FakeIdp | undefined;
    const directory = await mkdtemp(join(tmpdir(), 'telesphoros-decision-browser-'));
    try {
      db = await createEphemeralDatabase();
      idp = await startFakeIdp({ port: 4010, clientId: 'e2e-client', redirectUris: ['http://127.0.0.1:4173/auth/callback'], logoutUris: ['http://127.0.0.1:4173/signed-out'] });
      app = await createTestApp({
        postgresUrl: db.appUrl,
        labReportPipeline: true,
        medicationWrites: 'enabled',
        followupWrites: 'enabled',
        tokenVerifier: new CognitoTokenVerifier({ issuer: idp.issuer, clientId: idp.clientId, jwksUri: idp.jwksUri }),
        corsOrigins: ['http://127.0.0.1:4173'],
      });
      const clinician = { sub: idp.users[0]!.sub, token: await idp.mintAccessToken({ user: idp.users[0]! }) };
      const reviewerUser = idp.users.find((user) => user.email === 'gina@example.test')!;
      const reviewer = { sub: reviewerUser.sub, token: await idp.mintAccessToken({ user: reviewerUser }) };
      const lab = new LabPipeline(app, db.adminUrl, 'alpha');
      const fixtures: Record<string, unknown> = {};
      for (const viewport of ['mobile-375', 'desktop-1280']) {
        for (const scenario of ['decision', 'conflict', 'held', 'reviewer']) {
          const s = await lab.reviewedCapture(fixturePdf('D01'), { clinician, reviewer });
          const evaluation = (await lab.evaluate(clinician, s.reportId, { captureId: s.captureId, acceptanceId: s.acceptanceId }).expect(201)).body;
          const result = evaluation.results.find((item: { outcome: string }) => item.outcome === 'shown');
          expect(result).toBeDefined();
          const medication = (
            await lab
              .api()
              .post(`/api/v1/patients/${s.patientId}/medications`)
              .set(bearer(clinician.token))
              .send({
                requestId: crypto.randomUUID(),
                rxcui: BUNDLED_DRUG_LIST!.entries[0]!.rxcui,
                listVersion: BUNDLED_DRUG_LIST!.version,
                status: 'active',
                source: 'patient-reported',
                startMonth: '2026-01',
              })
              .expect(201)
          ).body;
          if (scenario === 'held') {
            await lab
              .api()
              .post(`/api/v1/evaluations/${evaluation.id}/corrections`)
              .set(bearer(reviewer.token))
              .send({ kind: 'retraction', reasonCode: 'wrong-patient' })
              .expect(201);
          }
          fixtures[`${viewport}:${scenario}`] = { patient: s.patientId, evaluation: evaluation.id, result: result.id, drug: result.drug, medication: medication.id };
        }
      }
      const file = join(directory, 'fixtures.json');
      await writeFile(file, JSON.stringify(fixtures), { mode: 0o600 });
      const args = ['exec', 'playwright', 'test', '--config', 'playwright.decisions.config.ts'];
      if (process.env.DECISION_BROWSER_GREP) args.push('--grep', process.env.DECISION_BROWSER_GREP);
      const api = await app.getUrl();
      const browserEnv: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: 'production', DECISION_FIXTURES: file, VITE_API_BASE_URL: api };
      delete browserEnv.JEST_WORKER_ID;
      const code = await new Promise<number | null>((done, reject) => {
        const child = spawn('pnpm', args, { cwd: resolve(__dirname, '../../frontend'), env: browserEnv, stdio: 'inherit', detached: true, timeout: 180_000 });
        const stopOwnedGroup = () => {
          try {
            if (child.pid) process.kill(-child.pid, 'SIGKILL');
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
          }
        };
        child.once('error', (error) => {
          try {
            stopOwnedGroup();
          } finally {
            reject(error);
          }
        });
        child.once('exit', (exitCode) => {
          try {
            stopOwnedGroup();
            done(exitCode);
          } catch (error) {
            reject(error);
          }
        });
      });
      expect(code).toBe(0);
      const verifier = LedgerVerifier.connect(db.verifierUrl);
      try {
        expect(await verifier.verify('alpha')).toMatchObject({ status: 'ok', failures: [] });
      } finally {
        await verifier.close();
      }
    } finally {
      await app?.close();
      await idp?.stop();
      await db?.drop();
      await rm(directory, { recursive: true, force: true });
    }
  }, 240_000);
});
