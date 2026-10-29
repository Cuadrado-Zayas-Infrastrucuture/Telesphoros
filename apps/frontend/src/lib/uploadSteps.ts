/** The real upload's steps in the one-screen workspace (specs/021 D2). Each lights up as the server reports the attempt's state. */
export const UPLOAD_STEPS = ['Sent to the server', 'Stored and checksum matched', 'Listed in your reports'] as const;
export const UPLOAD_WORDS = { done: 'Done', failed: 'Stopped', active: 'In progress', waiting: 'Waiting' };

/**
 * How far an upload attempt has got. Declared or intaking means sent; stored or committed means stored and checked. "Listed" is only set when
 * submitReport resolves, never from a state here, so a stored file that was not confirmed is never shown as listed.
 */
export function uploadStage(state: string | undefined): number {
  if (state === 'stored' || state === 'committed') return 2;
  if (state === 'declared' || state === 'intaking') return 1;
  return 0;
}
