import bundled from './drug-list/bundled.json';
import { drugListSchema, type DrugList } from './drug-list';

/**
 * The bundled list lives in its own entry point (`@telesphoros/shared-types/drug-list-data`), apart from the package index, so the
 * frontend loads it only with the patient screen instead of on every page. An absent verified artifact disables writes; a fabricated
 * fallback list is never used.
 */
export const BUNDLED_DRUG_LIST: DrugList | null = 'status' in bundled && bundled.status === 'verified' ? drugListSchema.parse(bundled) : null;
