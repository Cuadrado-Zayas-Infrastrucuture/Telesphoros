import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type { Role } from '@telesphoros/shared-types';
import { GLOSSARY_EN, HELP_EN, HELP_SCREENS } from '@telesphoros/help-content';
import { Button } from '@/components/ui/Button';
import { ContextDrawer } from '@/components/ui/ContextDrawer';
import { articlesFor, helpScreenOf, isPatientQuestion, searchHelp, type HelpHit } from '@/lib/helpSearch';
import { HELP_WORDS, helpFoot } from '@/lib/helpWords';

const titleOf = (hit: HelpHit) => (hit.kind === 'article' ? hit.article.title : `${HELP_WORDS.word}: ${hit.entry.term}`);
const keyOf = (hit: HelpHit) => (hit.kind === 'article' ? `article-${hit.article.id}` : `word-${hit.entry.id}`);

/**
 * Spec 051 slice H2: the help panel, in the app's side drawer (H-D4). It opens on the articles for this screen and these roles, searches
 * every article and every glossary word as the person types, and refuses a question about a patient before searching (section 5, H-D6).
 * It reads only the reviewed content, the screen's address and the roles: it sends nothing, stores nothing and reads no patient data.
 */
export function HelpPanel({ open, onClose, pathname, roles }: { open: boolean; onClose: () => void; pathname: string; roles: readonly Role[] }) {
  const [query, setQuery] = useState('');
  const [opened, setOpened] = useState<HelpHit | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const screen = helpScreenOf(pathname);
  const forThisPage = articlesFor(HELP_EN.articles, screen, roles).map((article): HelpHit => ({ kind: 'article', article }));
  const asked = query.trim();
  const refused = asked.length > 0 && isPatientQuestion(asked);
  const results = asked.length > 0 && !refused ? searchHelp(asked, HELP_EN.articles, GLOSSARY_EN, screen, roles) : null;
  // A question that matches nothing still offers the closest thing there is: this page's first articles (section 4).
  let listed = forThisPage;
  if (results) listed = results.hits.length > 0 ? results.hits : forThisPage.slice(0, 3);
  const show = (next: HelpHit | null) => {
    setOpened(next);
    heading.current?.focus();
  };
  const close = () => {
    setOpened(null);
    onClose();
  };
  return (
    <ContextDrawer open={open} onClose={close} title={HELP_WORDS.title} id="help-panel" closeLabel={HELP_WORDS.close} headingRef={heading}>
      {opened ? (
        <article aria-labelledby="help-open-heading" className="flex flex-col gap-3">
          <h3 id="help-open-heading" className="text-lg font-medium">
            {titleOf(opened)}
          </h3>
          {opened.kind === 'article' ? opened.article.body.map((paragraph) => <p key={paragraph}>{paragraph}</p>) : <p>{opened.entry.body}</p>}
          {opened.kind === 'article' && opened.article.links.length > 0 && (
            <ul className="flex flex-col gap-1">
              {opened.article.links.map((link) => (
                <li key={link.screen}>
                  <Link to={HELP_SCREENS[link.screen]} onClick={close} className="inline-flex min-h-control items-center font-medium underline underline-offset-2">
                    {link.label}
                  </Link>
                </li>
              ))}
            </ul>
          )}
          <p className="text-sm text-muted-foreground">{helpFoot(opened.kind === 'article' ? opened.article : opened.entry)}</p>
          <div>
            <Button variant="outline" className="min-h-control" onClick={() => show(null)}>
              {HELP_WORDS.back}
            </Button>
          </div>
        </article>
      ) : (
        <div className="flex flex-col gap-4">
          <label className="flex flex-col gap-1 text-sm font-medium">
            {HELP_WORDS.search}
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              autoComplete="off"
              spellCheck={false}
              className="min-h-control rounded-md border border-input bg-background px-3 text-base font-normal"
            />
          </label>
          <p className="text-sm text-muted-foreground">{HELP_WORDS.hint}</p>
          {refused ? (
            <div role="status" className="flex flex-col gap-2">
              <p>{HELP_EN.refusal?.body ?? HELP_WORDS.refusalFallback}</p>
              {screen === 'patient' && (
                <Link to={`${pathname}#patient-results`} onClick={close} className="inline-flex min-h-control items-center font-medium underline underline-offset-2">
                  {HELP_WORDS.patientResults}
                </Link>
              )}
            </div>
          ) : (
            <section aria-labelledby="help-list-heading" className="flex flex-col gap-2">
              <h3 id="help-list-heading" className="font-medium">
                {results ? HELP_WORDS.results : HELP_WORDS.forThisPage}
              </h3>
              {results && (results.weak || results.hits.length === 0) && <p role="status">{HELP_WORDS.weak}</p>}
              {listed.length === 0 ? (
                <p className="text-sm text-muted-foreground">{HELP_WORDS.nothingForThisPage}</p>
              ) : (
                <ul className="flex flex-col gap-1">
                  {listed.map((hit) => (
                    <li key={keyOf(hit)}>
                      <Button variant="ghost" className="min-h-control w-full justify-start text-left whitespace-normal" onClick={() => show(hit)}>
                        {titleOf(hit)}
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}
        </div>
      )}
    </ContextDrawer>
  );
}
