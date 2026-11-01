import { createRef } from 'react';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'vitest-axe';
import { describe, expect, it, vi } from 'vitest';
import { PatientPicker } from './PatientPicker';

const first = { id: 'patient-1', label: 'SYN-0001' };
const second = { id: 'patient-2', label: 'SYN-0002' };

describe('PatientPicker', () => {
  it('keeps its label, ref and validation description on the native select while it loads and retries', async () => {
    const ref = createRef<HTMLSelectElement>();
    const retry = vi.fn();
    const change = vi.fn();
    const view = (loading: boolean, error?: string) => (
      <>
        <label htmlFor="patient-choice">Patient</label>
        <p id="patient-help">Choose the report owner.</p>
        <PatientPicker
          id="patient-choice"
          ref={ref}
          patients={null}
          value=""
          onValueChange={change}
          loading={loading}
          error={error}
          onRetry={retry}
          aria-describedby="patient-help"
          aria-invalid
        />
      </>
    );
    const { rerender } = render(view(true));
    const select = screen.getByRole('combobox', { name: 'Patient' });
    expect(ref.current).toBe(select);
    expect(select).toBeDisabled();
    expect(select).toHaveAttribute('aria-busy', 'true');
    expect(select).toHaveAttribute('aria-invalid', 'true');
    expect(select).toHaveAccessibleDescription('Choose the report owner. Loading patients…');
    rerender(view(false, 'Patients unavailable.'));
    expect(select).toHaveAccessibleDescription('Choose the report owner. Patients unavailable.');
    expect(screen.getByRole('alert')).toHaveTextContent('Patients unavailable.');
    const retryButton = screen.getByRole('button', { name: 'Retry loading patients' });
    expect(retryButton).toHaveAttribute('type', 'button');
    await userEvent.click(retryButton);
    expect(retry).toHaveBeenCalledOnce();
    expect(change).not.toHaveBeenCalled();
  });

  it('preserves the selected patient outside the current page and emits only an explicit selection', async () => {
    const change = vi.fn();
    const { rerender } = render(<PatientPicker aria-label="Patient" patients={[second]} selectedPatient={first} value={first.id} onValueChange={change} />);
    const select = screen.getByRole('combobox', { name: 'Patient' });
    expect(select).toHaveValue(first.id);
    expect(within(select).getAllByRole('option')).toHaveLength(3);
    await userEvent.selectOptions(select, second.id);
    expect(change).toHaveBeenCalledExactlyOnceWith(second.id);
    rerender(<PatientPicker aria-label="Patient" patients={[first]} selectedPatient={first} value={first.id} onValueChange={change} />);
    expect(within(select).getAllByRole('option', { name: first.label })).toHaveLength(1);
  });

  it('explains an empty roster and offers creation only when its caller provides it, with independent accessible instances', async () => {
    const change = vi.fn();
    const { container, rerender } = render(<PatientPicker aria-label="Patient" patients={[]} value="" onValueChange={change} />);
    expect(screen.getByRole('status')).toHaveTextContent('No patients yet.');
    expect(screen.getAllByRole('option')).toHaveLength(1);
    expect(change).not.toHaveBeenCalled();
    rerender(
      <>
        <PatientPicker aria-label="Patient" patients={[]} value="" onValueChange={change} newPatientOption={{ value: 'new', label: 'New synthetic patient…' }} />
        <PatientPicker aria-label="Other patient" patients={null} value="" onValueChange={change} error="Unavailable." onRetry={() => {}} disabled />
      </>,
    );
    const select = screen.getByRole('combobox', { name: 'Patient' });
    await userEvent.selectOptions(select, 'new');
    expect(change).toHaveBeenCalledExactlyOnceWith('new');
    expect(select.id).not.toBe(screen.getByRole('combobox', { name: 'Other patient' }).id);
    expect(screen.getByRole('combobox', { name: 'Other patient' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Retry loading patients' })).toBeDisabled();
    expect(await axe(container)).toHaveNoViolations();
  });
});
