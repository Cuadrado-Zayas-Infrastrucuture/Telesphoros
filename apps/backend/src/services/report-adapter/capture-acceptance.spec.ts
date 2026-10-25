import { type CaptureAcceptance, InMemoryCaptureAcceptanceStore, type NewCaptureAcceptance } from './capture-acceptance';

const HASH = 'a'.repeat(64);
const record = (over: Partial<NewCaptureAcceptance> = {}): NewCaptureAcceptance => ({
  tenantId: 'alpha',
  textSha256: HASH,
  popplerVersion: '26.03.0',
  decision: 'accepted',
  reviewer: { sub: 'reviewer-1', tenantId: 'alpha' },
  note: null,
  ...over,
});

describe('capture acceptance (append-only)', () => {
  it('records a decision with an id and the time it was made, and returns it when asked for in the same tenant', async () => {
    const store = new InMemoryCaptureAcceptanceStore(() => new Date('2026-10-08T12:00:00Z'));
    const saved = await store.record(record());
    expect(saved).toMatchObject({ tenantId: 'alpha', textSha256: HASH, popplerVersion: '26.03.0', decision: 'accepted', decidedAt: '2026-10-08T12:00:00.000Z' });
    expect(saved.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(await store.get('alpha', saved.id)).toEqual(saved);
  });

  it('is asynchronous throughout, so a database can replace it without changing any caller', async () => {
    const store = new InMemoryCaptureAcceptanceStore();
    const pending = store.record(record());
    expect(pending).toBeInstanceOf(Promise);
    expect(store.get('alpha', 'x')).toBeInstanceOf(Promise);
    await pending;
  });

  it("never shows one tenant another tenant's record", async () => {
    const store = new InMemoryCaptureAcceptanceStore();
    const saved = await store.record(record());
    expect(await store.get('beta', saved.id)).toBeNull();
    expect(await store.get('alpha', 'no-such-id')).toBeNull();
  });

  it("refuses a reviewer from another tenant: nobody accepts a capture on another tenant's behalf", async () => {
    await expect(new InMemoryCaptureAcceptanceStore().record(record({ reviewer: { sub: 'someone', tenantId: 'beta' } }))).rejects.toThrow();
  });

  it.each([
    ['a short hash', { textSha256: 'abc' }],
    ['an upper-case hash', { textSha256: 'A'.repeat(64) }],
    ['a Poppler version that is not a version', { popplerVersion: 'latest' }],
    ['an unknown decision', { decision: 'maybe' as unknown as 'accepted' }],
    ['no reviewer identity', { reviewer: { sub: '', tenantId: 'alpha' } }],
    ['an over-long note', { note: 'x'.repeat(1001) }],
    ['an extra key', { extra: 1 } as unknown as Partial<NewCaptureAcceptance>],
  ])('refuses %s', async (_name, over) => {
    await expect(new InMemoryCaptureAcceptanceStore().record(record(over))).rejects.toThrow();
  });

  it('has no way to change or remove a record, and what it hands out cannot change what it keeps', async () => {
    const store = new InMemoryCaptureAcceptanceStore();
    expect(Object.getOwnPropertyNames(Object.getPrototypeOf(store)).sort()).toEqual(['constructor', 'get', 'record']);
    const saved = await store.record(record());
    (saved as { decision: string }).decision = 'rejected';
    expect(((await store.get('alpha', saved.id)) as CaptureAcceptance).decision).toBe('accepted');
  });

  it('keeps a later decision as a new record: a rejection never rewrites an acceptance', async () => {
    const store = new InMemoryCaptureAcceptanceStore();
    const accepted = await store.record(record());
    const rejected = await store.record(record({ decision: 'rejected', note: 'second look' }));
    expect(accepted.id).not.toBe(rejected.id);
    expect((await store.get('alpha', accepted.id))!.decision).toBe('accepted');
    expect((await store.get('alpha', rejected.id))!.decision).toBe('rejected');
  });
});
