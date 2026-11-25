import { IDENTITY_TABLE } from '@/lib/patientIdentity';
import type { AnyWordTable } from './defineWords';
import type { Screen } from './screens';
import { ACCOUNT_MENU_WORDS, FRAME_WORDS, SIDEBAR_WORDS } from './shell';
import { CALLBACK_WORDS, SIGNED_OUT_WORDS, SIGN_IN_WORDS } from './signIn';

/**
 * Each screen's word tables (spec 050 LS2a), so "a translated screen shows no English fixed string" (R5) is checked from data. A screen is listed in
 * TRANSLATED_SCREENS only once every table here has its signed Spanish. The header, footer and skip link of the `shell` come from the landing's copy,
 * and the consent bar from its own; both already have their Spanish (LS2-D2, LS2-D3).
 */
export const SCREEN_TABLES: Readonly<Record<Screen, readonly AnyWordTable[]>> = {
  shell: [SIDEBAR_WORDS, ACCOUNT_MENU_WORDS, FRAME_WORDS],
  'sign-in': [SIGN_IN_WORDS, SIGNED_OUT_WORDS, CALLBACK_WORDS],
  home: [],
  patient: [IDENTITY_TABLE],
};

/** Every word table, so `words.test.ts` checks each one (spec 050 R4, R7, R10). A new table is added here in the slice that adds it. */
export const WORD_TABLES: readonly AnyWordTable[] = Object.values(SCREEN_TABLES).flat();
