import { randomUUID } from 'node:crypto';
import { expectAppException } from '../../test/helpers/expect-app-exception';
import type { Principal } from '../auth/principal';
import { InMemoryObjectStorage } from '../object-storage/in-memory-object-storage';
import { InMemoryPatientsRepository } from '../storage/patients.repository';
import { InMemoryReportsRepository } from '../storage/reports.repository';
import { ReportsService } from './reports.service';

const alice: Principal = { sub: 'alice', roles: ['clinician'] };
const bob: Principal = { sub: 'bob', roles: ['clinician'] };
const input = (patientId: string) => ({ patientId, type: 'vcf' as const, filename: 'a.vcf', sizeBytes: 100 });

async function setup() {
  const patients = new InMemoryPatientsRepository();
  const service = new ReportsService(new InMemoryReportsRepository(), patients, new InMemoryObjectStorage(300));
  const now = new Date().toISOString();
  const mkPatient = async (ownerId: string) => {
    const id = randomUUID();
    await patients.insert({ id, ownerId, label: `SYN-${id.slice(0, 6)}`, createdAt: now, updatedAt: now });
    return id;
  };
  return { service, mkPatient };
}

describe('ReportsService', () => {
  describe('create', () => {
    it('registers metadata owned by the caller, always with status "received"', async () => {
      const { service, mkPatient } = await setup();
      const record = await service.create(alice, input(await mkPatient('alice')));
      expect(record).toMatchObject({ ownerId: 'alice', status: 'received', type: 'vcf', filename: 'a.vcf', sizeBytes: 100 });
    });

    it('treats a missing patient and another owner’s patient identically (NOT_FOUND)', async () => {
      const { service, mkPatient } = await setup();
      const bobsPatient = await mkPatient('bob');
      await expectAppException(service.create(alice, input(bobsPatient)), 404, 'NOT_FOUND');
      await expectAppException(service.create(alice, input(randomUUID())), 404, 'NOT_FOUND');
    });
  });

  describe('get and list', () => {
    it('get returns own record and hides others’', async () => {
      const { service, mkPatient } = await setup();
      const created = await service.create(alice, input(await mkPatient('alice')));
      await expect(service.get(alice, created.id)).resolves.toEqual(created);
      await expectAppException(service.get(bob, created.id), 404, 'NOT_FOUND');
    });

    it('list filters by patient, pages, and is owner-scoped', async () => {
      const { service, mkPatient } = await setup();
      const p1 = await mkPatient('alice');
      const p2 = await mkPatient('alice');
      await service.create(alice, input(p1));
      await service.create(alice, input(p1));
      await service.create(alice, input(p2));

      expect((await service.list(alice, { page: 1, pageSize: 10, patientId: p1 })).total).toBe(2);
      expect((await service.list(alice, { page: 1, pageSize: 10 })).total).toBe(3);
      expect((await service.list(alice, { page: 2, pageSize: 2 })).items).toHaveLength(1);
      expect((await service.list(bob, { page: 1, pageSize: 10 })).total).toBe(0);
    });
  });

  describe('patch', () => {
    it('changes only the provided fields and refreshes updatedAt', async () => {
      const { service, mkPatient } = await setup();
      const created = await service.create(alice, input(await mkPatient('alice')));
      await new Promise((resolve) => setTimeout(resolve, 5));
      const updated = await service.patch(alice, created.id, { filename: 'b.json' });
      expect(updated).toMatchObject({ filename: 'b.json', type: 'vcf', status: 'received' });
      expect(updated.updatedAt > created.updatedAt).toBe(true);
    });

    it('cannot patch another owner’s report', async () => {
      const { service, mkPatient } = await setup();
      const created = await service.create(alice, input(await mkPatient('alice')));
      await expectAppException(service.patch(bob, created.id, { type: 'structured' }), 404, 'NOT_FOUND');
    });
  });

  describe('remove', () => {
    it('deletes own report; cannot delete another owner’s', async () => {
      const { service, mkPatient } = await setup();
      const created = await service.create(alice, input(await mkPatient('alice')));
      await expectAppException(service.remove(bob, created.id), 404, 'NOT_FOUND');
      await service.remove(alice, created.id);
      await expectAppException(service.get(alice, created.id), 404, 'NOT_FOUND');
    });
  });
});
