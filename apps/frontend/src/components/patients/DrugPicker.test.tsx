import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { DrugPicker } from '@/components/patients/DrugPicker';

// Invented codes and names, apart from hydroxyzine for the FDA Tall Man form: a fixture, never product drug data.
vi.mock('@telesphoros/shared-types/drug-list-data', () => {
  const entry = (rxcui: string, name: string, displayName = name, brands?: { rxcui: string; name: string }[]) => ({
    rxcui,
    name,
    displayName,
    tty: name.includes(' / ') ? 'MIN' : 'IN',
    rxnormRelease: 'fixture',
    ...(brands ? { brands } : {}),
  });
  return {
    BUNDLED_DRUG_LIST: {
      version: 'a'.repeat(64),
      entries: [
        entry('991001', 'hydroxyzine', 'hydrOXYzine', [{ rxcui: '992003', name: 'Calmabrand' }]),
        entry('991002', 'synthetic alpha', 'synthetic alpha', [{ rxcui: '992001', name: 'Synthabrand' }]),
        entry('991010', 'synthetic alpha / synthetic beta', 'synthetic alpha / synthetic beta', [{ rxcui: '992002', name: 'Combobrand' }]),
        ...Array.from({ length: 8 }, (_, i) => entry(`99110${i}`, `synthetic gamma ${i}`)),
      ],
    },
  };
});

describe('drug picker', () => {
  it('finds an ingredient by brand, shows both names, and records the ingredient code', async () => {
    const onChange = vi.fn();
    render(<DrugPicker value="" disabled={false} onChange={onChange} />);
    await userEvent.type(screen.getByRole('combobox', { name: 'Drug' }), 'combo');
    const option = screen.getByRole('option', { name: 'Combobrand (synthetic alpha / synthetic beta)' });
    expect(option).toHaveTextContent('Combobrand (synthetic alpha / synthetic beta)');
    await userEvent.click(option);
    expect(onChange).toHaveBeenLastCalledWith('991010');
    // The field then shows the ingredient, which is what the record keeps.
    expect(screen.getByRole('combobox', { name: 'Drug' })).toHaveValue('synthetic alpha / synthetic beta');
  });
  it('keeps Tall Man lettering visual only when a brand finds a listed look-alike name', async () => {
    render(<DrugPicker value="" disabled={false} onChange={vi.fn()} />);
    await userEvent.type(screen.getByRole('combobox', { name: 'Drug' }), 'calma');
    expect(screen.getByRole('option', { name: 'Calmabrand (hydroxyzine)' })).toHaveTextContent('Calmabrand (hydrOXYzine)');
  });
  it('lists ingredient-name matches before brand matches, single ingredients before combinations, and asks for more letters past six', async () => {
    render(<DrugPicker value="" disabled={false} onChange={vi.fn()} />);
    await userEvent.type(screen.getByRole('combobox', { name: 'Drug' }), 'synth');
    const names = screen.getAllByRole('option').map((option) => option.getAttribute('aria-label'));
    expect(names).toHaveLength(6);
    // The branded single ingredient first, then the unbranded ones; the combination after them (specs/041 D1).
    expect(names.slice(0, 2)).toEqual(['synthetic alpha', 'synthetic gamma 0']);
    expect(names).not.toContain('synthetic alpha / synthetic beta');
    expect(names).not.toContain('Synthabrand (synthetic alpha)');
    expect(screen.getByText('6 suggestions. Type more letters to narrow the list.')).toBeInTheDocument();
  });
});
