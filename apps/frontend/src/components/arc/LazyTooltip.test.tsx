import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

// Each test gets its own copy of the module, so "has the tooltip's code arrived yet" starts from no every time.
beforeEach(() => vi.resetModules());
afterEach(() => vi.doUnmock('./Tooltip'));

const NAME = 'Patients';

async function show(label: string | undefined) {
  const { LazyTooltip } = await import('./LazyTooltip');
  render(
    <LazyTooltip label={label} side="right">
      <button type="button" aria-label={NAME}>
        <span aria-hidden="true">P</span>
      </button>
    </LazyTooltip>,
  );
}
const control = () => screen.getByRole('button', { name: NAME });
/** The tooltip marks the control it wraps with its open or closed state. */
const wrapped = () => waitFor(() => expect(control()).toHaveAttribute('data-state'));

it('shows the control at once, before the tooltip code has arrived', async () => {
  await show(NAME);
  expect(control()).not.toHaveAttribute('data-state');
  await wrapped();
});

it('names the control on keyboard focus once the code has arrived', async () => {
  const user = userEvent.setup();
  await show(NAME);
  await wrapped();
  await user.tab();
  expect(control()).toHaveFocus();
  expect(await screen.findByRole('tooltip')).toHaveTextContent(NAME);
});

it('keeps the keyboard focus on the control when the code arrives and wraps it', async () => {
  await show(NAME);
  const before = control();
  act(() => before.focus());
  expect(before).toHaveFocus();
  await wrapped();
  expect(control()).not.toBe(before);
  expect(control()).toHaveFocus();
});

it('fetches nothing for a control without a label', async () => {
  const fetched = vi.fn();
  vi.doMock('./Tooltip', () => {
    fetched();
    return { Tooltip: ({ children }: { children: ReactNode }) => children };
  });
  await show(undefined);
  await act(async () => {});
  expect(control()).not.toHaveAttribute('data-state');
  expect(fetched).not.toHaveBeenCalled();
  // The same counter does move once a control has a label, so the line above could have failed.
  await show('Reports');
  await waitFor(() => expect(fetched).toHaveBeenCalledOnce());
});
