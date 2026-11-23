import { BUNDLED_DRUG_LIST } from '@telesphoros/shared-types/drug-list-data';

/** Combination products are checked only as the combination (spec 039 D2, slice B decision B-D2); the bundled list knows which they are. */
export const isCombination = (rxcui: string) => BUNDLED_DRUG_LIST?.entries.find((entry) => entry.rxcui === rxcui)?.tty === 'MIN';
export const drugName = (rxcui: string) => BUNDLED_DRUG_LIST?.entries.find((entry) => entry.rxcui === rxcui)?.displayName ?? null;
