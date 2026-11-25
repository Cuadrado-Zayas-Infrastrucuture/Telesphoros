import { useMemo, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { GLOSSARY_EN, HELP_EN, HELP_SCREENS, type GlossaryEntry, type HelpArticle } from '@telesphoros/help-content';
import { useAuth } from '@/auth/AuthProvider';
import { CLINICAL_READ_ROLES } from '@/auth/roles';
import { Button } from '@/components/ui/Button';
import { ContextDrawer } from '@/components/ui/ContextDrawer';
import { Input } from '@/components/ui/Input';
import { glossaryFoot } from '@/lib/genomicProfileWords';
import { articlesForContext, helpScreenForPath, visibleArticlesForRoles } from './helpContext';
import { isPatientQuestion } from './patientRefusal';
import { searchHelp, WEAK_MATCH_MESSAGE } from './helpSearch';

type SelectedItem = { kind: 'article'; article: HelpArticle } | { kind: 'glossary'; entry: GlossaryEntry };

/**
 * Spec 051 slice H2: the curated Help panel in the app's side drawer. Opens on articles for the current screen
 * and viewer role, searches deterministically with zero network requests and zero storage of typed text, and
 * refuses patient-specific questions before searching.
 */
export function HelpDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { pathname, search } = useLocation();
  const { roles } = useAuth();
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<SelectedItem | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);

  // Clear typed text and selection on every close path so nothing typed is retained across openings.
  function handleClose() {
    setQuery('');
    setSelected(null);
    onClose();
  }

  const currentScreen = useMemo(() => helpScreenForPath(pathname), [pathname]);
  const visibleArticles = useMemo(() => visibleArticlesForRoles(HELP_EN.articles, roles), [roles]);
  const contextualArticles = useMemo(() => articlesForContext(HELP_EN.articles, currentScreen, roles), [currentScreen, roles]);
  const canReadClinical = useMemo(() => roles.some((role) => CLINICAL_READ_ROLES.includes(role)), [roles]);

  const trimmedQuery = query.trim();
  const refused = useMemo(() => (trimmedQuery.length > 0 ? isPatientQuestion(trimmedQuery) : false), [trimmedQuery]);
  const searchResult = useMemo(
    () => (trimmedQuery.length > 0 && !refused ? searchHelp(trimmedQuery, visibleArticles, GLOSSARY_EN, currentScreen) : null),
    [trimmedQuery, refused, visibleArticles, currentScreen],
  );

  function selectItem(item: SelectedItem) {
    setSelected(item);
    headingRef.current?.focus();
  }

  function clearSelection() {
    setSelected(null);
    headingRef.current?.focus();
  }

  function openPatientResults() {
    handleClose();
    const target = document.getElementById('genomic-profile-heading');
    if (target) {
      target.scrollIntoView?.({ block: 'start' });
      target.focus?.();
    }
  }

  const refusal = HELP_EN.refusal;

  return (
    <ContextDrawer open={open} onClose={handleClose} title="Help" id="help-drawer" closeLabel="Close help" headingRef={headingRef}>
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <label htmlFor="help-search" className="text-sm font-medium text-foreground">
            Search help
          </label>
          <Input
            id="help-search"
            type="search"
            autoComplete="off"
            value={query}
            placeholder="Search how the product works"
            onChange={(event) => {
              setQuery(event.target.value);
              setSelected(null);
            }}
          />
        </div>

        {refused && refusal ? (
          <div role="status" className="flex flex-col gap-3 rounded-md border border-divider bg-muted p-4">
            <p className="text-sm text-foreground">{refusal.body}</p>
            <p className="text-xs text-muted-foreground">{glossaryFoot(refusal)}</p>
            {currentScreen === 'patient' ? (
              <div>
                <Link
                  to={{ pathname, search, hash: '#genomic-profile-heading' }}
                  onClick={openPatientResults}
                  className="inline-flex min-h-control items-center text-sm font-medium text-primary underline underline-offset-4"
                >
                  Open this patient&apos;s results
                </Link>
              </div>
            ) : canReadClinical ? (
              <div>
                <Link to="/patients" onClick={handleClose} className="inline-flex min-h-control items-center text-sm font-medium text-primary underline underline-offset-4">
                  Open Patients
                </Link>
              </div>
            ) : null}
          </div>
        ) : selected ? (
          <article className="flex flex-col gap-3">
            <div>
              <Button variant="outline" size="sm" onClick={clearSelection}>
                {trimmedQuery ? 'Back to results' : 'Back to help'}
              </Button>
            </div>
            {selected.kind === 'article' ? (
              <>
                <h3 className="text-base font-medium text-foreground">{selected.article.title}</h3>
                {selected.article.body.map((paragraph, index) => (
                  <p key={index} className="text-sm text-foreground">
                    {paragraph}
                  </p>
                ))}
                {selected.article.links.length > 0 && (
                  <ul className="flex flex-wrap gap-2 pt-1">
                    {selected.article.links.map((link) => (
                      <li key={link.screen}>
                        <Link
                          to={HELP_SCREENS[link.screen]}
                          onClick={handleClose}
                          className="inline-flex min-h-control items-center rounded-md border border-divider px-3 text-sm font-medium text-primary hover:bg-muted"
                        >
                          {link.label}
                        </Link>
                      </li>
                    ))}
                  </ul>
                )}
                <p className="text-xs text-muted-foreground">{glossaryFoot(selected.article)}</p>
              </>
            ) : (
              <>
                <p className="text-xs font-medium text-muted-foreground">Word</p>
                <h3 className="text-base font-medium text-foreground">{selected.entry.term}</h3>
                <p className="text-sm text-foreground">{selected.entry.body}</p>
                <p className="text-xs text-muted-foreground">{glossaryFoot(selected.entry)}</p>
              </>
            )}
          </article>
        ) : searchResult ? (
          <div className="flex flex-col gap-3">
            {searchResult.weak && (
              <p role="status" className="text-sm text-muted-foreground">
                {WEAK_MATCH_MESSAGE}
              </p>
            )}
            {searchResult.results.length > 0 ? (
              <ul className="flex flex-col gap-2">
                {searchResult.results.map((hit) => (
                  <li key={hit.id}>
                    <button
                      type="button"
                      onClick={() => selectItem(hit.kind === 'article' ? { kind: 'article', article: hit.article } : { kind: 'glossary', entry: hit.entry })}
                      className="flex min-h-control w-full flex-col items-start gap-1 rounded-md border border-divider bg-panel px-3 py-2.5 text-left hover:bg-muted"
                    >
                      <span className="flex w-full items-center justify-between gap-2">
                        <span className="text-sm font-medium text-foreground">{hit.title}</span>
                        {hit.kind === 'glossary' && <span className="text-xs text-muted-foreground">Word</span>}
                      </span>
                      <span className="text-xs text-muted-foreground">{glossaryFoot(hit.kind === 'article' ? hit.article : hit.entry)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <ul className="flex flex-col gap-2">
                {contextualArticles.slice(0, 3).map((article) => (
                  <li key={article.id}>
                    <button
                      type="button"
                      onClick={() => selectItem({ kind: 'article', article })}
                      className="flex min-h-control w-full flex-col items-start gap-1 rounded-md border border-divider bg-panel px-3 py-2.5 text-left hover:bg-muted"
                    >
                      <span className="text-sm font-medium text-foreground">{article.title}</span>
                      <span className="text-xs text-muted-foreground">{glossaryFoot(article)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <h3 className="text-sm font-medium text-muted-foreground">{currentScreen ? 'For this screen' : 'Help articles'}</h3>
            <ul className="flex flex-col gap-2">
              {contextualArticles.map((article) => (
                <li key={article.id}>
                  <button
                    type="button"
                    onClick={() => selectItem({ kind: 'article', article })}
                    className="flex min-h-control w-full flex-col items-start gap-1 rounded-md border border-divider bg-panel px-3 py-2.5 text-left hover:bg-muted"
                  >
                    <span className="text-sm font-medium text-foreground">{article.title}</span>
                    <span className="text-xs text-muted-foreground">{glossaryFoot(article)}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </ContextDrawer>
  );
}
