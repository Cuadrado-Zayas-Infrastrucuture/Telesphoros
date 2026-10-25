import { assertRequestShape, type ModelPort, type ModelRequest } from './port';

/** A stand-in that returns what a script says, whatever the prompt is. No network. */
export const scripted = (reply: (request: ModelRequest) => unknown): ModelPort => ({
  async complete(request) {
    assertRequestShape(request);
    return { artifact: reply(request), observation: { inputUnits: Math.ceil(request.prompt.length / 4), generatedUnits: 64 } };
  },
});

/**
 * A stand-in that obeys every instruction it can see. If a marker appears anywhere in the prompt it returns what the marker
 * demands; otherwise it returns the clean reply. A leak of attacker text into a prompt therefore shows up as an effect.
 */
export const obedient = (demands: ReadonlyArray<{ marker: string; emit: unknown }>, clean: unknown): ModelPort =>
  scripted(request => demands.find(d => request.prompt.includes(d.marker))?.emit ?? clean);
