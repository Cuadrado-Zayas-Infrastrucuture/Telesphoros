import { randomUUID } from 'node:crypto';
import { expectAppException } from '../../test/helpers/expect-app-exception';
import type { Principal } from '../auth/principal';
import { InMemoryRecommendationsRepository } from '../storage/recommendations.repository';
import type { RecommendationRecord } from '../storage/records';
import { RecommendationsService } from './recommendations.service';

const alice: Principal = { sub: 'alice', tenantId: 'alice', roles: ['reader'] };
const bob: Principal = { sub: 'bob', tenantId: 'bob', roles: ['reader'] };
const rec = (over: Partial<RecommendationRecord> = {}): RecommendationRecord => ({
  id: randomUUID(), tenantId: 'alice', createdBy: 'alice', patientId: randomUUID(), reportId: randomUUID(), gene: 'G', drug: 'd',
  phenotype: 'p', summary: 's', strength: 'Strong', guidelineVersion: 'v0', createdAt: new Date().toISOString(), ...over,
});

describe('RecommendationsService', () => {
  it('list is tenant-scoped and filters by patient and report', async () => {
    const repo = new InMemoryRecommendationsRepository();
    const service = new RecommendationsService(repo);
    const patientId = randomUUID();
    const reportId = randomUUID();
    await repo.insert(rec({ patientId, reportId }));
    await repo.insert(rec({ patientId }));
    await repo.insert(rec());
    await repo.insert(rec({ tenantId: 'bob' }));

    expect((await service.list(alice, { page: 1, pageSize: 10 })).total).toBe(3);
    expect((await service.list(alice, { page: 1, pageSize: 10, patientId })).total).toBe(2);
    expect((await service.list(alice, { page: 1, pageSize: 10, patientId, reportId })).total).toBe(1);
    expect((await service.list(bob, { page: 1, pageSize: 10 })).total).toBe(1);
  });

  it('get returns own record, NOT_FOUND for someone else’s or a missing one', async () => {
    const repo = new InMemoryRecommendationsRepository();
    const service = new RecommendationsService(repo);
    const mine = rec();
    await repo.insert(mine);
    await expect(service.get(alice, mine.id)).resolves.toEqual(mine);
    await expectAppException(service.get(bob, mine.id), 404, 'NOT_FOUND');
    await expectAppException(service.get(alice, randomUUID()), 404, 'NOT_FOUND');
  });
});
