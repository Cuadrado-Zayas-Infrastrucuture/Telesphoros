import { expect, test } from 'vitest';
import { REQUEST_KEYS, type ModelRequest } from '../src/model-clients/port';
import { obedient, scripted } from '../src/model-clients/scripted';

const request: ModelRequest = { prompt: 'p', templateDigest: 'sha256:' + '0'.repeat(64), maxOutputUnits: 10 };
test('the port request has exactly three fields and no tools', async () => {
  expect([...REQUEST_KEYS]).toEqual(['maxOutputUnits', 'prompt', 'templateDigest']);
  await expect(scripted(() => 1).complete(request)).resolves.toMatchObject({ artifact: 1 });
  await expect(scripted(() => 1).complete({ ...request, tools: [] } as unknown as ModelRequest)).rejects.toThrow('PORT_SHAPE');
  // @ts-expect-error a tools field is not part of the request type
  const typed: ModelRequest = { ...request, tools: [] };
  expect(typed).toBeDefined();
});
test('the obedient stand-in obeys a marker it sees and only then', async () => {
  const port = obedient([{ marker: 'ZZ', emit: 'obeyed' }], 'clean');
  expect((await port.complete({ ...request, prompt: 'has ZZ in it' })).artifact).toBe('obeyed');
  expect((await port.complete(request)).artifact).toBe('clean');
});
