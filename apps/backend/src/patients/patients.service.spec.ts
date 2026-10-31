import { randomUUID } from 'node:crypto';
import { expectAppException } from '../../test/helpers/expect-app-exception';
import { AppException } from '../common/app-exception';
import type { Principal } from '../auth/principal';
import { PatientHasMergedRecordsError } from '../storage/errors';
import { UnavailablePatientDemographicsRepository } from '../storage/patient-demographics.repository';
import { InMemoryPatientsRepository } from '../storage/patients.repository';
import { InMemoryReportsRepository } from '../storage/reports.repository';
import { PatientsService } from './patients.service';

const alice: Principal = { sub: 'alice', tenantId: 'alice', roles: ['clinician'] };
const bob: Principal = { sub: 'bob', tenantId: 'bob', roles: ['clinician'] };

function setup() {
  const patients = new InMemoryPatientsRepository();
  const reports = new InMemoryReportsRepository();
  return { service: new PatientsService(patients, reports, new UnavailablePatientDemographicsRepository()), patients, reports };
}

describe('PatientsService', () => {
  describe('create', () => {
    it('stores an owned record with a uuid and matching timestamps', async () => {
      const { service, patients } = setup();
      const record = await service.create(alice, { label: 'SYN-1' });
      expect(record.tenantId).toBe('alice');
      expect(record.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(record.createdAt).toBe(record.updatedAt);
      expect(await patients.findById('alice', record.id)).toEqual(record);
    });

    it('rejects a duplicate label for the same tenant, ignoring case', async () => {
      const { service } = setup();
      await service.create(alice, { label: 'SYN-1' });
      await expectAppException(service.create(alice, { label: 'syn-1' }), 409, 'CONFLICT');
    });

    it('allows the same label for a different tenant', async () => {
      const { service } = setup();
      await service.create(alice, { label: 'SYN-1' });
      await expect(service.create(bob, { label: 'SYN-1' })).resolves.toBeDefined();
    });
  });

  describe('get', () => {
    it('returns the caller’s own record', async () => {
      const { service } = setup();
      const created = await service.create(alice, { label: 'SYN-1' });
      await expect(service.get(alice, created.id)).resolves.toEqual(created);
    });

    it('reports another tenant’s record and a missing record identically (NOT_FOUND)', async () => {
      const { service } = setup();
      const created = await service.create(alice, { label: 'SYN-1' });
      await expectAppException(service.get(bob, created.id), 404, 'NOT_FOUND');
      await expectAppException(service.get(alice, randomUUID()), 404, 'NOT_FOUND');
    });
  });

  describe('list', () => {
    it('pages with offset/limit, reports the tenant’s total, and excludes other tenants', async () => {
      const { service } = setup();
      for (let i = 1; i <= 5; i++) await service.create(alice, { label: `SYN-${i}` });
      await service.create(bob, { label: 'SYN-BOB' });

      const page = await service.list(alice, { page: 2, pageSize: 2 });
      expect(page.total).toBe(5);
      expect(page.items.map((p) => p.label)).toEqual(['SYN-3', 'SYN-4']);
      expect((await service.list(alice, { page: 9, pageSize: 2 })).items).toEqual([]);
    });
  });

  describe('replace', () => {
    it('changes the label and refreshes updatedAt, keeping id and tenant', async () => {
      const { service } = setup();
      const created = await service.create(alice, { label: 'SYN-1' });
      await new Promise((resolve) => setTimeout(resolve, 5));
      const updated = await service.replace(alice, created.id, { label: 'SYN-2' });
      expect(updated).toMatchObject({ id: created.id, tenantId: 'alice', label: 'SYN-2' });
      expect(updated.updatedAt > created.updatedAt).toBe(true);
    });

    it('lets a record keep its own label, but not take another record’s', async () => {
      const { service } = setup();
      const one = await service.create(alice, { label: 'SYN-1' });
      await service.create(alice, { label: 'SYN-2' });
      await expect(service.replace(alice, one.id, { label: 'SYN-1' })).resolves.toBeDefined();
      await expectAppException(service.replace(alice, one.id, { label: 'SYN-2' }), 409, 'CONFLICT');
    });

    it('cannot touch another tenant’s record', async () => {
      const { service } = setup();
      const created = await service.create(alice, { label: 'SYN-1' });
      await expectAppException(service.replace(bob, created.id, { label: 'X' }), 404, 'NOT_FOUND');
      expect((await service.get(alice, created.id)).label).toBe('SYN-1');
    });
  });

  describe('remove', () => {
    it('deletes the caller’s record', async () => {
      const { service } = setup();
      const created = await service.create(alice, { label: 'SYN-1' });
      await service.remove(alice, created.id);
      await expectAppException(service.get(alice, created.id), 404, 'NOT_FOUND');
    });

    it('refuses while reports reference the patient (the ON DELETE RESTRICT rule)', async () => {
      const { service, reports } = setup();
      const created = await service.create(alice, { label: 'SYN-1' });
      await reports.insert({
        id: randomUUID(),
        tenantId: 'alice',
        createdBy: 'alice',
        patientId: created.id,
        type: 'structured',
        filename: 'a.json',
        sizeBytes: 1,
        status: 'received',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      await expectAppException(service.remove(alice, created.id), 409, 'CONFLICT');
    });

    it('answers 409 when a merge lands after the check and the database refuses the delete (migration 0034)', async () => {
      const { service, patients } = setup();
      const created = await service.create(alice, { label: 'SYN-1' });
      jest.spyOn(patients, 'delete').mockRejectedValueOnce(new PatientHasMergedRecordsError());
      const error = await service.remove(alice, created.id).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(AppException);
      expect((error as AppException).getStatus()).toBe(409);
      expect((error as AppException).details?.[0]).toMatchObject({ reason: 'patient-has-merged-records' });
      await expect(service.get(alice, created.id)).resolves.toBeDefined();
    });

    it('does not turn other storage failures into a conflict', async () => {
      const { service, patients } = setup();
      const created = await service.create(alice, { label: 'SYN-1' });
      jest.spyOn(patients, 'delete').mockRejectedValueOnce(new Error('connection lost'));
      await expect(service.remove(alice, created.id)).rejects.toThrow('connection lost');
    });

    it('cannot delete another tenant’s record', async () => {
      const { service } = setup();
      const created = await service.create(alice, { label: 'SYN-1' });
      await expectAppException(service.remove(bob, created.id), 404, 'NOT_FOUND');
      await expect(service.get(alice, created.id)).resolves.toBeDefined();
    });
  });
});
