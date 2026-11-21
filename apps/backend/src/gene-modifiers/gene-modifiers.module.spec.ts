import type { Env } from '../config/env';
import { KnowledgeLoadError } from '../services/knowledge/knowledge-loader';
import { cleanupTempDirs, MODIFIER_TEST_IDS, signedModifierCopy, signerKeysJson, SYNTHETIC_MODIFIERS_DIR } from '../../test/helpers/knowledge';
import { geneModifiersFactory } from './gene-modifiers.module';

afterAll(cleanupTempDirs);

/** The factory reads three settings; the rest of the environment does not matter to it. */
const envOf = (settings: Partial<Env>) => settings as Env;

describe('geneModifiersFactory (spec 045 N1)', () => {
  it('loads nothing while GENE_MODIFIERS_DIR is unset (PN-6)', async () => {
    expect(await geneModifiersFactory(envOf({ NODE_ENV: 'development', KNOWLEDGE_SIGNER_KEYS: signerKeysJson() }))).toBeUndefined();
  });

  it('loads a signed list under the production rules (control for the refusal below)', async () => {
    const set = await geneModifiersFactory(envOf({ NODE_ENV: 'development', GENE_MODIFIERS_DIR: await signedModifierCopy(), KNOWLEDGE_SIGNER_KEYS: signerKeysJson() }));
    expect(set?.mode).toBe('production');
    expect(set?.modifiersOf(MODIFIER_TEST_IDS.rxcui.drugp)).toHaveLength(1);
  });

  it.each(['development', 'test', 'production'] as const)('applies the production rules with NODE_ENV=%s: the synthetic lists are refused (PN-1)', async (NODE_ENV) => {
    const loading = geneModifiersFactory(envOf({ NODE_ENV, GENE_MODIFIERS_DIR: SYNTHETIC_MODIFIERS_DIR, KNOWLEDGE_SIGNER_KEYS: signerKeysJson() }));
    await expect(loading).rejects.toThrow(KnowledgeLoadError);
    await expect(loading).rejects.toThrow(/syn-modifiers-a\.json: synthetic test content is not allowed in production\./);
  });

  it('refuses a signed list when the signers are not configured', async () => {
    await expect(geneModifiersFactory(envOf({ NODE_ENV: 'development', GENE_MODIFIERS_DIR: await signedModifierCopy() }))).rejects.toThrow(/no signer keys are configured/);
  });
});
