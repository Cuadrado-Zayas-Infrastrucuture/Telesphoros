import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { Button } from './Button';

it('blocks repeat activation while pending, then allows retry', async () => {
  const click = vi.fn();
  const user = userEvent.setup();
  const { rerender } = render(
    <Button pending pendingLabel="Saving…" disabled={false} onClick={click}>
      Save
    </Button>,
  );
  const button = screen.getByRole('button', { name: 'Saving…' });
  expect(button).toBeDisabled();
  expect(button).toHaveAttribute('aria-busy', 'true');
  expect(screen.getByRole('status')).toHaveTextContent('Saving…');
  await user.click(button);
  await user.keyboard('{Enter} ');
  expect(click).not.toHaveBeenCalled();
  rerender(
    <Button pending={false} pendingLabel="Saving…" onClick={click}>
      Save
    </Button>,
  );
  expect(screen.getByRole('status')).toBeEmptyDOMElement();
  await user.click(screen.getByRole('button', { name: 'Save' }));
  expect(click).toHaveBeenCalledOnce();
});

it('preserves a separate disabled reason after loading ends', () => {
  render(
    <Button pending={false} pendingLabel="Saving…" disabled>
      Save
    </Button>,
  );
  expect(screen.getByRole('button')).toBeDisabled();
});

it('keeps link composition and default non-submit behavior', () => {
  render(
    <>
      <Button asChild>
        <a href="/reports">Reports</a>
      </Button>
      <Button>Cancel</Button>
    </>,
  );
  expect(screen.getByRole('link', { name: 'Reports' })).toHaveAttribute('href', '/reports');
  expect(screen.getByRole('button', { name: 'Cancel' })).toHaveAttribute('type', 'button');
  expect(screen.queryByRole('status')).not.toBeInTheDocument();
});
