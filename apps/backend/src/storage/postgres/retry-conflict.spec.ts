import { retryOnConflict } from './retry-conflict';

const pgError = (code: string) => Object.assign(new Error(`pg ${code}`), { code });

describe('retryOnConflict', () => {
  it.each(['40P01', '40001'])('runs the work again once after %s, and returns what the second run returns', async (code) => {
    const work = jest.fn().mockRejectedValueOnce(pgError(code)).mockResolvedValueOnce('done');
    await expect(retryOnConflict(work)).resolves.toBe('done');
    expect(work).toHaveBeenCalledTimes(2);
  });

  it("retries only once: a second conflict is the caller's", async () => {
    const work = jest.fn().mockRejectedValue(pgError('40P01'));
    await expect(retryOnConflict(work)).rejects.toMatchObject({ code: '40P01' });
    expect(work).toHaveBeenCalledTimes(2);
  });

  it.each(['23505', '23503', '57014', '55P03', '08006', '42501'])('does not retry %s', async (code) => {
    const work = jest.fn().mockRejectedValue(pgError(code));
    await expect(retryOnConflict(work)).rejects.toMatchObject({ code });
    expect(work).toHaveBeenCalledTimes(1);
  });

  it('does not retry an error with no code, or one that is not an error object', async () => {
    for (const thrown of [new Error('plain'), 'a string', null, undefined, { code: 40001 }]) {
      const work = jest.fn().mockRejectedValue(thrown);
      await expect(retryOnConflict(work)).rejects.toBe(thrown);
      expect(work).toHaveBeenCalledTimes(1);
    }
  });

  it('runs successful work once', async () => {
    const work = jest.fn().mockResolvedValue(7);
    await expect(retryOnConflict(work)).resolves.toBe(7);
    expect(work).toHaveBeenCalledTimes(1);
  });
});
