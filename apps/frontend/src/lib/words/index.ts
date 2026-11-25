import { IDENTITY_TABLE } from '@/lib/patientIdentity';
import type { AnyWordTable } from './defineWords';

/** Every word table, so `words.test.ts` checks each one (spec 050 R4, R7, R10). A new table is added here in the slice that adds it. */
export const WORD_TABLES: readonly AnyWordTable[] = [IDENTITY_TABLE];
