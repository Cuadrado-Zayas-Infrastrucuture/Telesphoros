import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { DEMO_SOURCE } from '@/lib/interpretationDemo';
import { uploadStage, UPLOAD_STEPS } from '@/lib/uploadSteps';
import { PromptInput } from './PromptInput';
import { PromptInputTextarea } from './PromptInputTextarea';
import { Source } from './Source';
import { Steps } from './Steps';

// specs/021: the props added for the one-screen workspace must leave the chat preview exactly as it was.
describe('Prompt Kit adapters keep their defaults (specs/021)', () => {
  it('Steps with no props is the chat preview’s simulated process, words uncolored', () => {
    render(<Steps stage={1} />);
    const list = screen.getByRole('list', { name: 'Simulated process steps' });
    expect(
      within(list)
        .getAllByRole('listitem')
        .map((item) => item.querySelector('p')?.textContent),
    ).toEqual(['Load example context', 'Check evidence availability', 'Prepare fixed response']);
    const done = within(list).getByText('Demonstrated');
    expect(done).toHaveClass('text-muted-foreground');
    expect(done).not.toHaveClass('text-success');
    expect(within(list).getByText('In progress · simulated')).toBeInTheDocument();
  });

  it('Steps with the upload’s labels says done, stopped and waiting as colored words', () => {
    render(<Steps stage={1} failed labels={UPLOAD_STEPS} words={{ done: 'Done', failed: 'Stopped', active: 'In progress', waiting: 'Waiting' }} label="Upload" colored />);
    const list = screen.getByRole('list', { name: 'Upload' });
    expect(within(list).getByText('Done')).toHaveClass('text-success');
    expect(within(list).getByText('Stopped')).toHaveClass('text-destructive');
    expect(within(list).getByText('Waiting')).toHaveClass('text-muted-foreground');
  });

  it('Source with no props is the fixed demo source; with props it shows the caller’s honest wording', () => {
    const { unmount } = render(<Source defaultOpen />);
    expect(screen.getByText(DEMO_SOURCE)).toBeInTheDocument();
    expect(screen.getByText(/not a clinical citation/)).toBeInTheDocument();
    unmount();
    render(<Source defaultOpen title="Attached: SYN-004.json · not read by the sample engine" description="Fixed example." />);
    expect(screen.getByText('Attached: SYN-004.json · not read by the sample engine')).toBeInTheDocument();
    expect(screen.queryByText(DEMO_SOURCE)).not.toBeInTheDocument();
  });

  it('PromptInput keeps its name and refuses empty text unless the caller allows it', () => {
    const submit = vi.fn();
    const { rerender } = render(
      <PromptInput onSubmit={submit} value="" onValueChange={() => undefined}>
        <PromptInputTextarea aria-label="Question" />
      </PromptInput>,
    );
    expect(screen.getByRole('form', { name: 'Synthetic explanation prompt' })).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Question' }), { key: 'Enter' });
    expect(submit).not.toHaveBeenCalled();
    rerender(
      <PromptInput onSubmit={submit} value="" onValueChange={() => undefined} allowEmpty label="Report and question">
        <PromptInputTextarea aria-label="Question" />
      </PromptInput>,
    );
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Question' }), { key: 'Enter' });
    expect(submit).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('form', { name: 'Report and question' })).toBeInTheDocument();
  });

  it('upload steps come from the server’s attempt state, and “listed” never comes from a state', () => {
    expect(uploadStage(undefined)).toBe(0);
    expect(uploadStage('declared')).toBe(1);
    expect(uploadStage('intaking')).toBe(1);
    expect(uploadStage('stored')).toBe(2);
    expect(uploadStage('committed')).toBe(2);
    expect(uploadStage('cancelled')).toBe(0);
    expect(Math.max(...['declared', 'intaking', 'stored', 'committed', 'unresolved'].map(uploadStage))).toBeLessThan(UPLOAD_STEPS.length);
  });
});
