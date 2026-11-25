import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'vitest-axe';
import { describe, expect, it, vi } from 'vitest';
import { PatientSearchField } from '@/components/patients/PatientSearchField';
import type { PatientSearch } from '@/hooks/usePatientSearch';

// Spec 040 slice C. From #483, adapted to the field that merged in #482: it has no Clear button; changing the text drops the search.
describe('PatientSearchField (spec 040 slice C)', () => {
  it('searches the trimmed text on Enter without submitting an outer form, and changing the text drops the search', async () => {
    const onOuterSubmit = vi.fn((event: React.FormEvent) => event.preventDefault());
    const onSearch = vi.fn();
    const onReset = vi.fn();
    const { container } = render(
      <form onSubmit={onOuterSubmit}>
        <PatientSearchField state={{ status: 'idle' }} onSearch={onSearch} onMore={vi.fn()} onReset={onReset} />
        <button type="submit">Submit outer</button>
      </form>,
    );

    const input = screen.getByRole('textbox', { name: 'Find a patient' });
    await userEvent.type(input, ' SYN-42 {Enter}');

    expect(onSearch).toHaveBeenCalledExactlyOnceWith('SYN-42');
    expect(onOuterSubmit).not.toHaveBeenCalled();

    onReset.mockClear();
    await userEvent.clear(input);
    expect(input).toHaveValue('');
    expect(onReset).toHaveBeenCalled();
    expect(await axe(container)).toHaveNoViolations();
  });

  it('renders refused, found (with More matches), and failed (with Retry) states accessibly', async () => {
    const onSearch = vi.fn();
    const onMore = vi.fn();
    const refused: PatientSearch = { status: 'refused', message: 'Use letters, numbers and hyphens only.' };
    const { container, rerender } = render(<PatientSearchField state={refused} onSearch={onSearch} onMore={onMore} onReset={vi.fn()} />);

    const input = screen.getByRole('textbox', { name: 'Find a patient' });
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveAccessibleDescription(expect.stringContaining('Use letters, numbers and hyphens only.'));

    const found: PatientSearch = {
      status: 'found',
      text: 'SYN',
      patients: [],
      total: 25,
      hasMore: true,
      loadingMore: false,
      moreFailed: true,
    };
    rerender(<PatientSearchField state={found} onSearch={onSearch} onMore={onMore} onReset={vi.fn()} />);
    expect(input).toHaveAccessibleDescription('Searched all patients: 25 matches. The choices below are the matches.');
    expect(screen.getByRole('alert')).toHaveTextContent('More matches could not be loaded. Please retry.');
    await userEvent.click(screen.getByRole('button', { name: 'More matches' }));
    expect(onMore).toHaveBeenCalledOnce();

    const failed: PatientSearch = {
      status: 'failed',
      text: 'SYN-42',
      message: 'The whole list could not be searched. Showing the loaded patients only.',
    };
    rerender(<PatientSearchField state={failed} onSearch={onSearch} onMore={onMore} onReset={vi.fn()} />);
    expect(screen.getByRole('alert')).toHaveTextContent('The whole list could not be searched. Showing the loaded patients only.');
    expect(screen.queryByText(/Searched all patients/)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Retry searching all patients' }));
    expect(onSearch).toHaveBeenCalledExactlyOnceWith('SYN-42');
    expect(await axe(container)).toHaveNoViolations();
  });
});
