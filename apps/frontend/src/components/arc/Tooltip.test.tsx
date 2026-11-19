import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it } from 'vitest';
import { axe } from 'vitest-axe';
import { Tooltip } from './Tooltip';

const NAME = 'Refresh follow-ups';

function show(disabled = false) {
  render(
    <Tooltip label={NAME}>
      <button type="button" aria-label={NAME} disabled={disabled}>
        <span aria-hidden="true">R</span>
      </button>
    </Tooltip>,
  );
  return screen.getByRole('button', { name: NAME });
}

it('shows nothing at rest, and the control carries no native title', () => {
  const button = show();
  expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  expect(button).not.toHaveAttribute('title');
});

it('shows the name on keyboard focus, and Escape hides it without moving focus', async () => {
  const user = userEvent.setup();
  const button = show();
  await user.tab();
  expect(button).toHaveFocus();
  expect(await screen.findByRole('tooltip')).toHaveTextContent(NAME);
  await user.keyboard('{Escape}');
  await waitFor(() => expect(screen.queryByRole('tooltip')).not.toBeInTheDocument());
  expect(button).toHaveFocus();
});

it('shows the name on hover', async () => {
  const user = userEvent.setup();
  const button = show();
  await user.hover(button);
  expect(await screen.findByRole('tooltip')).toHaveTextContent(NAME);
});

it('links the name to the control only while it shows', async () => {
  const user = userEvent.setup();
  const button = show();
  expect(button).not.toHaveAttribute('aria-describedby');
  await user.tab();
  const tooltip = await screen.findByRole('tooltip');
  expect(button).toHaveAttribute('aria-describedby', tooltip.id);
});

// Hover still names a disabled control in a real browser (measured, specs/042 T009); jsdom cannot show that.
it('shows none from the keyboard for a disabled control, which takes no focus', async () => {
  const user = userEvent.setup();
  const button = show(true);
  await user.tab();
  expect(button).not.toHaveFocus();
  expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
});

// The whole document, because the label is drawn outside the rendered container. The rule set is the one the browser suites
// hold every page to (e2e/helpers.ts): WCAG 2 A and AA. axe's best-practice `region` rule is outside it, and would flag the
// label for sitting outside the page's landmarks (specs/042, "Not verified").
it('has no WCAG A or AA violations while it shows', async () => {
  const user = userEvent.setup();
  show();
  await user.tab();
  await screen.findByRole('tooltip');
  expect(await axe(document.body, { runOnly: ['wcag2a', 'wcag2aa', 'wcag21aa'] })).toHaveNoViolations();
});
