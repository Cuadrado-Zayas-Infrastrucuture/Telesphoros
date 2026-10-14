// Adapted from Prompt Kit Image: only the bundled synthetic image, no arbitrary URL or upload preview.
import { useRef, useState } from 'react';
import { Maximize2, X } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import fixture from '@/assets/local-D01.svg';
export function Image() {
  const dialog = useRef<HTMLDialogElement>(null);
  const [zoomed, setZoomed] = useState(false);
  return <div><Button size="sm" variant="outline" className="h-auto min-h-control w-full whitespace-normal" onClick={() => { setZoomed(false); dialog.current?.showModal(); }}><Maximize2 aria-hidden="true" className="size-4 shrink-0" />Preview bundled source image</Button><dialog ref={dialog} aria-labelledby="source-image-title" className="preview-image-dialog rounded-lg border border-border bg-panel p-5 text-foreground"><div className="mb-4 flex flex-wrap items-center justify-between gap-3"><h2 id="source-image-title" className="text-xl">Synthetic source image</h2><Button variant="outline" size="sm" onClick={() => dialog.current?.close()}><X aria-hidden="true" className="size-4" />Close image</Button></div><p className="mb-4 text-sm">Bundled SYN-D01 fixture. Not your attachment; not interpreted or clinically approved.</p><div className="mb-3 flex flex-wrap items-center justify-between gap-2"><p className="text-xs text-muted-foreground">Zoom to inspect the original text; scroll inside the image.</p><Button variant="outline" size="sm" aria-pressed={zoomed} onClick={() => setZoomed(value => !value)}>{zoomed ? "Fit to width" : "Zoom image"}</Button></div><div role="region" aria-label="Source image viewport" tabIndex={0} className="preview-image-viewport rounded-md border border-divider"><img src={fixture} alt="Bundled synthetic laboratory fixture SYN-D01. No interpretation is performed." width="612" height="792" loading="lazy" className={zoomed ? "preview-image-zoom h-auto max-w-none" : "h-auto w-full"} /></div></dialog></div>;
}
