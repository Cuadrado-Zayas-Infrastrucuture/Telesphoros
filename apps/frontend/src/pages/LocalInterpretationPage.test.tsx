import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import LocalInterpretationPage from './LocalInterpretationPage';
import { demoAnswer } from '@/lib/interpretationDemo';

vi.mock('@/auth/AuthProvider', () => ({ useAuth: () => ({ roles: ['clinician'] }) }));

beforeEach(() => { vi.useFakeTimers(); vi.stubGlobal('location', { hostname: '127.0.0.1' }); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
function open() { return render(<MemoryRouter><LocalInterpretationPage /></MemoryRouter>); }
async function finish() { await act(async () => { await vi.advanceTimersByTimeAsync(1500); }); }
it('uses fixed local responses and never calls fetch or writes storage', async () => {
  const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
  const storage = vi.spyOn(Storage.prototype, 'setItem');
  open(); fireEvent.click(screen.getByRole('button', { name: 'Explain this example' }));
  fireEvent.click(screen.getByRole('button', { name: 'What evidence is missing?' }));
  expect(screen.getByRole('status')).toHaveTextContent('Loading a fixed synthetic response');
  await finish(); expect(screen.getByText(/No genotype, phenotype/)).toBeInTheDocument();
  expect(screen.queryByText(/^This example has no accepted/)).not.toBeInTheDocument();
  expect(fetch).not.toHaveBeenCalled(); expect(storage).not.toHaveBeenCalled();
});
it('stop and reset prevent late answers, clear content and restore keyboard focus', async () => {
  open(); await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Explain this example' })); });
  fireEvent.click(screen.getByRole('button', { name: 'Stop' })); await finish();
  expect(screen.getByRole('status')).toHaveTextContent('stopped');
  expect(screen.queryByText(/No genotype, phenotype/)).not.toBeInTheDocument();
  expect(screen.getByLabelText('Sample question')).toHaveFocus();
  fireEvent.click(screen.getByRole('button', { name: 'What are the limitations?' }));
  fireEvent.click(screen.getByRole('button', { name: 'Reset' })); await finish();
  expect(screen.getByLabelText('Sample question')).toHaveValue('');
  expect(screen.getByRole('status')).toHaveTextContent('reset');
  expect(screen.queryByText(/^These words are/)).not.toBeInTheDocument();
});
it('simulated failure retries the same question without duplicate work', async () => {
  open(); fireEvent.click(screen.getByRole('button', { name: 'Simulate next response failure' }));
  fireEvent.click(screen.getByRole('button', { name: 'What evidence is missing?' })); await finish();
  expect(screen.getByRole('alert')).toHaveTextContent('simulated failure');
  fireEvent.click(screen.getByRole('button', { name: 'Retry sample response' })); await finish();
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  expect(screen.getByText(/^This example has no accepted/)).toBeInTheDocument();
});
it('Enter submits; Shift+Enter and composition do not; text renders as text', async () => {
  open(); const input = screen.getByLabelText('Sample question');
  fireEvent.change(input, { target: { value: '<script>example</script>' } });
  fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
  fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
  expect(screen.queryByRole('button', { name: 'Stop' })).not.toBeInTheDocument();
  fireEvent.keyDown(input, { key: 'Enter' }); await finish();
  expect(screen.getByText('<script>example</script>', { selector: 'p' })).toBeInTheDocument();
  expect(screen.getByText(/only demonstrates three fixed questions/)).toBeInTheDocument();
  expect(document.querySelector('script')).toBeNull();
});
it('cancels the active stage timer on unmount', async () => {
  const mounted = open(); const scheduled = vi.spyOn(globalThis, 'setTimeout'); const cleared = vi.spyOn(globalThis, 'clearTimeout');
  fireEvent.click(screen.getByRole('button', { name: 'Explain this example' }));
  await act(async () => { await vi.advanceTimersByTimeAsync(450); });
  const index = scheduled.mock.calls.findLastIndex(call => call[1] === 450);
  const activeTimer = scheduled.mock.results[index].value;
  mounted.unmount(); expect(cleared).toHaveBeenCalledWith(activeTimer);
});
it.each(['localhost', 'example.com'])('refuses non-local preview host %s', hostname => {
  vi.stubGlobal('location', { hostname }); open();
  expect(screen.getByRole('heading', { name: 'Preview unavailable' })).toBeInTheDocument();
  expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
});
it('refuses the component in production even if mounted accidentally', () => {
  vi.stubEnv('DEV', false); open();
  expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
});
it.each(['constructor', '__proto__', 'toString'])('unknown question %s cannot select inherited object properties', question => {
  expect(demoAnswer(question)).toContain('only demonstrates three fixed questions');
});
it('keeps per-exchange local feedback and bounds the conversation at six exchanges', async () => {
  open();
  for (let count = 0; count < 6; count++) {
    fireEvent.click(screen.getByRole('button', { name: 'Explain this example' })); await finish();
  }
  const feedback = screen.getAllByRole('button', { name: 'Helpful' }).filter(button => button.getAttribute('aria-label') === 'Helpful');
  expect(feedback).toHaveLength(6);
  fireEvent.click(feedback[0]); expect(feedback[0]).toHaveAttribute('aria-pressed', 'true');
  expect(feedback[1]).toHaveAttribute('aria-pressed', 'false');
  expect(screen.getByRole('status')).toHaveTextContent('Six sample exchanges reached');
  fireEvent.click(screen.getByRole('button', { name: 'Explain this example' })); await finish();
  expect(screen.getAllByText('Fixed demonstration copy · not model output')).toHaveLength(6);
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Reset' })); });
  expect(screen.queryByText('Fixed demonstration copy · not model output')).not.toBeInTheDocument();
  expect(screen.getByLabelText('Sample question')).toBeEnabled();
});
it('uses SDK regeneration for retry and retains one exchange after repeated failures', async () => {
  const { syntheticChatTransport } = await import('@/lib/syntheticChatTransport');
  const send = vi.spyOn(syntheticChatTransport, 'sendMessages');
  open();
  fireEvent.click(screen.getByRole('button', { name: 'Simulate next response failure' }));
  fireEvent.click(screen.getByRole('button', { name: 'Explain this example' })); await finish();
  fireEvent.click(screen.getByRole('button', { name: 'Simulate next response failure' }));
  fireEvent.click(screen.getByRole('button', { name: 'Retry sample response' })); await finish();
  fireEvent.click(screen.getByRole('button', { name: 'Retry sample response' })); await finish();
  expect(send.mock.calls.map(([request]) => request.trigger)).toEqual(['submit-message', 'regenerate-message', 'regenerate-message']);
  expect(send.mock.calls.map(([request]) => request.messages.filter(message => message.role === 'user').length)).toEqual([1, 1, 1]);
  expect(screen.getAllByText('Fixed demonstration copy · not model output')).toHaveLength(1);
  send.mockRestore();
});
it('reset during SDK preparation cannot resurrect an old exchange and allows a new one', async () => {
  open();
  fireEvent.click(screen.getByRole('button', { name: 'Explain this example' }));
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Reset' })); });
  fireEvent.click(screen.getByRole('button', { name: 'What evidence is missing?' })); await finish();
  expect(screen.queryByText(/No genotype, phenotype/)).not.toBeInTheDocument();
  expect(screen.getAllByText('Fixed demonstration copy · not model output')).toHaveLength(1);
  expect(screen.getByText(/^This example has no accepted/)).toBeInTheDocument();
});
it('stopping later work preserves completed messages and their feedback', async () => {
  open(); fireEvent.click(screen.getByRole('button', { name: 'Explain this example' })); await finish();
  fireEvent.click(screen.getByRole('button', { name: 'Helpful' }));
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'What evidence is missing?' })); });
  await act(async () => { await vi.advanceTimersByTimeAsync(900); });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Stop' })); });
  await finish();
  expect(screen.getAllByText('Fixed demonstration copy · not model output')).toHaveLength(1);
  expect(screen.queryByText(/^This example has no accepted/)).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Helpful' })).toHaveAttribute('aria-pressed', 'true');
});
