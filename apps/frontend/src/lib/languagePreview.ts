/**
 * Spec 050 LS2-D1: a preview of the app's Spanish for the founders, who read their own text in place before anyone can choose it (LS6). A build-time
 * opt-in, `VITE_LANGUAGE_PREVIEW=true`, allowed only in a development, test or e2e build: any other build refuses it at start-up, so a staging or
 * production build can never carry the control.
 */
const PREVIEW_MODES = ['development', 'test', 'e2e'];

export function languagePreviewEnabled(mode: string = import.meta.env.MODE): boolean {
  const setting = import.meta.env.VITE_LANGUAGE_PREVIEW;
  if (setting !== undefined && setting !== '' && setting !== 'true' && setting !== 'false') throw new Error('Invalid language preview setting.');
  if (setting === 'true' && !PREVIEW_MODES.includes(mode)) throw new Error('The language preview is for development, test and e2e builds only.');
  return setting === 'true';
}
