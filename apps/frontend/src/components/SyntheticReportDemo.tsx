import { useId, useState } from 'react';
import type { ReportDto } from '@telesphoros/shared-types';
import { Button } from '@/components/ui/Button';
import { ownedStorageMode } from '@/lib/storageMode';

// Display-only copies of D01/D08 in tests/report_adapter/golden.json. Never an engine or evaluation record.
const EXAMPLES = {
  fd2b6475143803a2add6446de753cbbe61879b567fa016b10434d7b5d38aac14: 'D01',
  ae0da40e71aeef9ef9b1b8ca306e7d0a24aecd77ed1ea974d0695e431e8c7289: 'D08',
} as const;

export function SyntheticReportDemo({ report }: { report: ReportDto }) {
  const [open, setOpen] = useState(false);
  const contentId = useId();
  if (!ownedStorageMode() || location.hostname !== '127.0.0.1' || report.type !== 'lab-pdf') return null;
  const example = report.fileUploaded && report.sha256 ? EXAMPLES[report.sha256 as keyof typeof EXAMPLES] : undefined;
  return (
    <section aria-label="Fixed synthetic PGx demo" className="border-t border-divider pt-4">
      <h3 className="text-base text-primary">PGx demo</h3>
      <p className="mt-2 text-sm text-muted-foreground">Fixed synthetic data. No reader, rules engine or model has run on this upload.</p>
      {!example ? (
        <p className="mt-3 text-sm">
          {report.fileUploaded ? 'No fixed example matches this file. Other uploads are not analyzed.' : 'Complete the upload before opening a fixed example.'}
        </p>
      ) : (
        <>
          <p className="mt-2 text-sm">Bundled example {example}, matched by the server-verified file fingerprint.</p>
          <Button variant="outline" className="mt-4 w-full whitespace-normal" aria-expanded={open} aria-controls={contentId} onClick={() => setOpen(!open)}>
            {open ? 'Hide fixed sample' : example === 'D01' ? 'Show fixed sample result' : 'Show held sample'}
          </Button>
          {open && (
            <div id={contentId} className="mt-4 space-y-4">
              {example === 'D01' ? (
                <>
                  <h4 className="text-base text-primary">Sample result</h4>
                  <table className="w-full text-left text-sm">
                    <caption className="pb-2 text-left font-semibold">Fixed gene findings</caption>
                    <thead>
                      <tr>
                        <th scope="col" className="py-2">
                          Gene
                        </th>
                        <th scope="col" className="py-2">
                          Sample diplotype
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr className="border-t border-divider">
                        <th scope="row" className="py-2 font-normal">
                          CYP2C19
                        </th>
                        <td className="py-2">*1/*2</td>
                      </tr>
                      <tr className="border-t border-divider">
                        <th scope="row" className="py-2 font-normal">
                          CYP2B6
                        </th>
                        <td className="py-2">*1/*1</td>
                      </tr>
                    </tbody>
                  </table>
                  <div className="space-y-3">
                    <h5 className="text-sm font-semibold">Invented guideline examples</h5>
                    <div className="border-l-2 border-divider pl-3">
                      <p className="text-sm font-semibold">Test Drug Q</p>
                      <p className="mt-1 text-sm">Q intermediate.</p>
                      <p className="mt-1 text-xs text-muted-foreground">Sample strength: Moderate</p>
                    </div>
                    <div className="border-l-2 border-divider pl-3">
                      <p className="text-sm font-semibold">Test Drug R</p>
                      <p className="mt-1 text-sm">R intermediate-normal.</p>
                      <p className="mt-1 text-xs text-muted-foreground">Sample strength: Strong</p>
                    </div>
                  </div>
                </>
              ) : (
                <>
                  <h4 className="text-base text-warning">Sample held</h4>
                  <p className="text-sm">Text alignment needs review. This fixed example illustrates an unsupported report layout; no gene or drug result is shown.</p>
                  <p className="text-xs text-muted-foreground">Sample reason: alignment-unsupported</p>
                </>
              )}
              <p className="border-t border-divider pt-3 text-xs text-muted-foreground">
                Source: hand-authored synthetic example {example}. These are invented test values, not CPIC guidance or clinical advice. No capture approval or evaluation has been
                recorded.
              </p>
            </div>
          )}
        </>
      )}
    </section>
  );
}
