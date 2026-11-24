import { Module } from '@nestjs/common';
import { ENV, type Env } from '../config/env';
import { loadGeneModifiers } from '../services/knowledge/gene-modifier-loader';
import { parseSignerKeys } from '../services/knowledge/signatures';
import { GENE_MODIFIERS, type GeneModifierSet } from './gene-modifier-set';

/**
 * Spec 045 N1: loads GENE_MODIFIERS_DIR once at start, always under the production rules (PN-1), whatever NODE_ENV says: reviewed, not
 * synthetic, two valid signatures. A list that does not load stops the start, as bad knowledge does. Unset, nothing is loaded.
 */
export const geneModifiersFactory = async (env: Env): Promise<GeneModifierSet | undefined> => {
  if (!env.GENE_MODIFIERS_DIR) return undefined;
  return loadGeneModifiers({ directory: env.GENE_MODIFIERS_DIR, mode: 'production', signerKeys: parseSignerKeys(env.KNOWLEDGE_SIGNER_KEYS) });
};

/** Nothing reads the lists yet: the genomic profile does from spec 045 N2. */
@Module({
  providers: [{ provide: GENE_MODIFIERS, inject: [ENV], useFactory: geneModifiersFactory }],
  exports: [GENE_MODIFIERS],
})
export class GeneModifiersModule {}
