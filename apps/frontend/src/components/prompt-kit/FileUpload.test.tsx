import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { FileUpload } from './FileUpload';
const syntheticFile = () => new File(['SYNTHETIC ONLY'], 'SYN-example.json', { type: 'application/json' });
it('requires confirmation, retains metadata only, and removes it with focus recovery', () => {
  const fetch = vi.spyOn(globalThis, 'fetch');
  const read = vi.spyOn(FileReader.prototype, 'readAsText');
  render(<FileUpload canAttach busy={false} />);
  const input = screen.getByLabelText('Choose synthetic attachment');
  expect(screen.getByRole('button', { name: 'Choose file' })).toBeDisabled();
  fireEvent.change(input, { target: { files: [syntheticFile()] } });
  expect(screen.queryByText('SYN-example.json')).not.toBeInTheDocument();
  fireEvent.click(screen.getByLabelText('This file contains synthetic data only'));
  fireEvent.change(input, { target: { files: [syntheticFile()] } });
  expect(screen.getByText('SYN-example.json')).toBeInTheDocument();
  expect(fetch).not.toHaveBeenCalled();
  expect(read).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Remove attachment' }));
  expect(screen.queryByText('SYN-example.json')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Choose file' })).toHaveFocus();
});
it('rejects unsupported, empty, oversized, and multiple files through the drop path', () => {
  render(<FileUpload canAttach busy={false} />);
  fireEvent.click(screen.getByLabelText('This file contains synthetic data only'));
  for (const files of [
    [new File(['x'], 'SYN.exe')],
    [new File([], 'SYN.json')],
    [new File([new Uint8Array(5 * 1024 * 1024 + 1)], 'SYN.pdf')],
    [syntheticFile(), syntheticFile()],
  ]) {
    fireEvent.drop(screen.getByRole('region', { name: 'Synthetic attachment preview' }), { dataTransfer: { files } });
    expect(screen.getByRole('alert')).toHaveTextContent('Choose one nonempty');
    expect(screen.queryByRole('button', { name: 'Remove attachment' })).not.toBeInTheDocument();
  }
});
it('drop cannot bypass role or busy restrictions, and consent removal clears metadata', () => {
  const { rerender } = render(<FileUpload canAttach={false} busy={false} />);
  fireEvent.drop(screen.getByRole('region', { name: 'Synthetic attachment preview' }), { dataTransfer: { files: [syntheticFile()] } });
  expect(screen.queryByText('SYN-example.json')).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Choose file' })).not.toBeInTheDocument();
  rerender(<FileUpload canAttach busy={false} />);
  fireEvent.click(screen.getByLabelText('This file contains synthetic data only'));
  rerender(<FileUpload canAttach busy />);
  fireEvent.drop(screen.getByRole('region', { name: 'Synthetic attachment preview' }), { dataTransfer: { files: [syntheticFile()] } });
  expect(screen.queryByText('SYN-example.json')).not.toBeInTheDocument();
  rerender(<FileUpload canAttach busy={false} />);
  fireEvent.drop(screen.getByRole('region', { name: 'Synthetic attachment preview' }), { dataTransfer: { files: [syntheticFile()] } });
  expect(screen.getByText('SYN-example.json')).toBeInTheDocument();
  fireEvent.click(screen.getByLabelText('This file contains synthetic data only'));
  expect(screen.queryByText('SYN-example.json')).not.toBeInTheDocument();
});
