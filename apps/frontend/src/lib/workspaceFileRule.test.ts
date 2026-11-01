import { afterEach, describe, expect, it, vi } from 'vitest';
import { chatFileAccept, fileProblem } from '@/lib/workspaceFileRule';

afterEach(() => vi.unstubAllEnvs());

describe('what the chat offers is what it accepts (specs/024 D4)', () => {
  it('offers .json alone in a published build, and refuses nothing it offers', () => {
    expect(chatFileAccept()).toBe('.json');
    for (const extension of chatFileAccept().split(',')) expect(fileProblem(`report${extension}`)).toBeNull();
  });

  it('also offers .pdf in owned-storage mode, and refuses nothing it offers', () => {
    vi.stubEnv('VITE_LOCAL_STORAGE_INTAKE', 'true');
    expect(chatFileAccept()).toBe('.json,.pdf');
    for (const extension of chatFileAccept().split(',')) expect(fileProblem(`report${extension}`)).toBeNull();
  });
});
