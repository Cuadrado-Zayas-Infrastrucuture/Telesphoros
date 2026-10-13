// Adapted from Prompt Kit FileUpload; scoped drag/drop, explicit synthetic confirmation, no byte reads.
import { useRef, useState } from 'react';
import { FileText, Paperclip, X } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Checkbox } from '@/components/ui/Checkbox';
export function FileUpload({ canAttach, busy }: { canAttach: boolean; busy: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [attachment, setAttachment] = useState<{ name: string; size: number } | null>(null);
  const [error, setError] = useState('');
  const [dragging, setDragging] = useState(false);
  const disabled = !canAttach || !confirmed || busy;
  function accept(files: File[]) {
    if (disabled) return;
    if (files.length !== 1 || files[0].size === 0 || files[0].size > 5 * 1024 * 1024 || !/\.(pdf|png|jpe?g|json|vcf)$/i.test(files[0].name)) {
      setError('Choose one nonempty PDF, PNG, JPEG, JSON or VCF file, up to 5 MB.'); return;
    }
    // Retain only display metadata. Never read bytes, create object URLs or send the File.
    setAttachment({ name: files[0].name.slice(0, 160), size: files[0].size }); setError('');
  }
  return <section aria-label="Synthetic attachment preview" onDragOver={event => { event.preventDefault(); if (!disabled) setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={event => { event.preventDefault(); setDragging(false); accept(Array.from(event.dataTransfer.files)); }} className={`rounded-lg border border-dashed p-4 ${dragging && !disabled ? 'border-primary bg-muted' : 'border-border bg-panel'}`}>
    <h3 className="text-sm">Try an attachment</h3><p id="demo-attachment-help" className="mt-2 text-xs leading-relaxed text-muted-foreground">Local metadata preview only. File contents are not read, uploaded or used in responses.</p>
    {canAttach ? <><label htmlFor="demo-file-confirmed" className="my-3 flex min-h-control cursor-pointer items-center gap-3 text-sm"><Checkbox id="demo-file-confirmed" checked={confirmed} disabled={busy} onChange={event => { setConfirmed(event.target.checked); setAttachment(null); setError(''); }} />This file contains synthetic data only</label><input ref={input} type="file" accept=".pdf,.png,.jpg,.jpeg,.json,.vcf" disabled={disabled} aria-label="Choose synthetic attachment" className="hidden" onChange={event => { accept(Array.from(event.target.files ?? [])); event.target.value = ''; }} /><Button id="choose-demo-file" aria-describedby={error ? "demo-attachment-help demo-file-error" : "demo-attachment-help"} variant="outline" size="sm" disabled={disabled} className="h-auto min-h-control w-full whitespace-normal" onClick={() => input.current?.click()}><Paperclip aria-hidden="true" className="size-4" />Choose file</Button><p className="mt-2 text-xs text-muted-foreground">Or drop one file here · maximum 5 MB</p></> : <p className="mt-3 text-sm">Attachment controls require clinician or admin access. Sample explanations remain available.</p>}
    {error && <p id="demo-file-error" role="alert" className="mt-3 text-sm text-destructive">{error}</p>}
    {attachment && <div className="mt-3 flex items-start gap-2 border-t border-divider pt-3"><FileText aria-hidden="true" className="mt-3 size-4 shrink-0" /><div className="min-w-0 flex-1 pt-2 text-xs wrap-anywhere"><p className="font-semibold">{attachment.name}</p><p className="mt-1 text-muted-foreground">{attachment.size.toLocaleString()} bytes · local only</p></div><Button variant="ghost" size="sm" aria-label="Remove attachment" disabled={busy} onClick={() => { setAttachment(null); document.getElementById('choose-demo-file')?.focus(); }}><X aria-hidden="true" className="size-4" /></Button></div>}
  </section>;
}
