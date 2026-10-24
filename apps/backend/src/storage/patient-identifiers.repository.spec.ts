import { randomBytes } from 'node:crypto';
import { InMemoryPatientIdentifiersRepository } from './patient-identifiers.repository';
import { InMemoryPatientsRepository, type PatientsRepository } from './patients.repository';

// The development store follows the same rule as PostgreSQL (test/db/patient-delete-identifiers.pg-spec.ts): a deleted patient holds no identifier.
describe('in-memory store: the identifiers of a deleted patient', () => {
  it('can be registered to another patient', async () => {
    const patients: PatientsRepository = new InMemoryPatientsRepository();
    const identifiers = new InMemoryPatientIdentifiersRepository(patients);
    const stamp = new Date().toISOString();
    for (const id of ['p1', 'p2']) await patients.insert({ id, tenantId: 't', createdBy: 'a', label: id, createdAt: stamp, updatedAt: stamp });
    const value = randomBytes(32);
    await identifiers.add('t', 'a', { patientId: 'p1', system: 's', digest: value, keyVersion: 1 });
    await expect(identifiers.add('t', 'a', { patientId: 'p2', system: 's', digest: value, keyVersion: 1 })).rejects.toMatchObject({ name: 'IdentifierInUseError' });
    await patients.delete('t', 'p1', 'a');
    await expect(identifiers.add('t', 'a', { patientId: 'p2', system: 's', digest: value, keyVersion: 1 })).resolves.toMatchObject({ patientId: 'p2' });
  });
});
