import { useRef, useState, type ReactNode } from 'react';
import { GLOSSARY_EN } from '@telesphoros/help-content';
import { Button } from '@/components/ui/Button';
import { ContextDrawer } from '@/components/ui/ContextDrawer';
import { GlossaryContext, type GlossaryView } from '@/lib/genomicGlossary';
import { GLOSSARY_WORDS, glossaryFoot } from '@/lib/genomicProfileWords';

/**
 * Spec 044 slice B part 2 (B-D4, B2-D3): the glossary of the genomic profile, in the app's side drawer. General education about a word, the
 * same for every patient. Each entry says at its foot who reviewed and signed it, or that it is a draft not yet reviewed (B2-D2). The
 * drawer closes with Escape and returns focus to the word that opened it; its text is in the page only while it is open.
 */
export function GenomicGlossary({ children }: { children: ReactNode }) {
  const [view, setView] = useState<GlossaryView | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const entry = view !== null && view !== 'all' ? view : null;
  const title = entry ? entry.term : GLOSSARY_WORDS.listTitle;
  // Moving between an entry and the list inside the open drawer keeps focus in it, on its heading.
  const show = (next: GlossaryView) => {
    setView(next);
    heading.current?.focus();
  };
  return (
    <GlossaryContext.Provider value={setView}>
      {children}
      <ContextDrawer open={view !== null} onClose={() => setView(null)} title={title} id="genomic-glossary" closeLabel={GLOSSARY_WORDS.close} headingRef={heading}>
        {entry && (
          <div className="flex flex-col gap-3">
            <p>{entry.body}</p>
            <p className="text-sm text-muted-foreground">{glossaryFoot(entry)}</p>
            <div>
              <Button variant="outline" size="sm" onClick={() => show('all')}>
                {GLOSSARY_WORDS.allTerms}
              </Button>
            </div>
          </div>
        )}
        {view === 'all' && (
          <ul className="flex flex-col gap-1">
            {GLOSSARY_EN.map((item) => (
              <li key={item.id}>
                <Button variant="ghost" size="sm" onClick={() => show(item)}>
                  {item.term}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </ContextDrawer>
    </GlossaryContext.Provider>
  );
}
