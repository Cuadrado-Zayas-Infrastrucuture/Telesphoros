import { Info } from 'lucide-react';
import { Tooltip } from '@/components/arc/Tooltip';
import { Button } from '@/components/ui/Button';
import { useGlossary } from '@/lib/genomicGlossary';
import { GLOSSARY_WORDS } from '@/lib/genomicProfileWords';

/** The ⓘ beside the genomic profile's heading: every glossary term, in the side drawer. It explains words; it never carries a safety statement. */
export function GlossaryListButton() {
  const open = useGlossary();
  if (!open) return null;
  return (
    <Tooltip label={GLOSSARY_WORDS.listTitle}>
      <Button variant="ghost" size="sm" className="shrink-0 px-0" aria-label={GLOSSARY_WORDS.listTitle} aria-haspopup="dialog" onClick={() => open('all')}>
        <Info aria-hidden="true" className="size-4 shrink-0" />
      </Button>
    </Tooltip>
  );
}
