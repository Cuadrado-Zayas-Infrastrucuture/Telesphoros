import { resolve } from 'node:path';
import { loadKnowledge } from '../services/knowledge/knowledge-loader';
import type { KnowledgeSet } from '../services/knowledge/knowledge-set';
import type { DisputeStatus } from '../storage/ledger-records';
import { toDisputeDto } from './lab-report.mapper';

// `inForce` says whether a dispute holds a cell NOW: open or upheld, and the loaded file is still the one that was disputed.
const TEST_KNOWLEDGE = resolve(__dirname, '../../../../data/fixtures/knowledge/test-only-reader');

describe('toDisputeDto: inForce', () => {
  let knowledge: KnowledgeSet;
  beforeAll(async () => {
    knowledge = await loadKnowledge({ directory: TEST_KNOWLEDGE, mode: 'non-production' });
  });
  const guideline = () => knowledge.allGuidelines()[0]!;
  const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const status = (over: Record<string, unknown> = {}, state: DisputeStatus['status'] = 'open'): DisputeStatus => ({
    dispute: {
      id: uuid(1), tenantId: 't', seq: '1', createdBy: 'syn', createdAt: '2026-10-08T00:00:00.000000Z', guidelineId: guideline().id, guidelineVersion: guideline().guidelineVersion,
      guidelineContentSha256: knowledge.files.find((f) => f.id === guideline().id)!.contentSha256, locatorTable: 'Table', locatorRow: 'Row', locatorColumn: null,
      note: { id: uuid(2), bodySha256: 'a'.repeat(64) }, ...over,
    },
    status: state,
    decision: state === 'open' ? null : { id: uuid(3), tenantId: 't', seq: '2', createdBy: 'syn2', createdAt: '2026-10-08T00:00:01.000000Z', decision: state, evidence: { id: uuid(4), bodySha256: 'b'.repeat(64) } },
  });

  it('is true for an open or an upheld dispute about the loaded file, and false once dismissed', () => {
    expect(toDisputeDto(status(), knowledge).inForce).toBe(true);
    expect(toDisputeDto(status({}, 'upheld'), knowledge).inForce).toBe(true);
    expect(toDisputeDto(status({}, 'dismissed'), knowledge).inForce).toBe(false);
  });

  it('is false when the file was corrected and re-signed (another content hash), or is another version, or is no longer loaded', () => {
    for (const over of [{ guidelineContentSha256: 'c'.repeat(64) }, { guidelineVersion: `${guideline().guidelineVersion}-next` }, { guidelineId: 'gone' }]) {
      expect(toDisputeDto(status(over), knowledge).inForce).toBe(false);
      expect(toDisputeDto(status(over, 'upheld'), knowledge).inForce).toBe(false);
    }
  });

  it('shows the decision without any text, and the locator column as null when absent', () => {
    const dto = toDisputeDto(status({}, 'upheld'), knowledge);
    expect(dto.decision).toEqual({ id: uuid(3), decision: 'upheld', evidence: { id: uuid(4), bodySha256: 'b'.repeat(64) }, createdAt: '2026-10-08T00:00:01.000000Z' });
    expect(dto.locator).toEqual({ table: 'Table', row: 'Row', column: null });
    expect(JSON.stringify(dto)).not.toMatch(/createdBy|tenant/);
  });
});
