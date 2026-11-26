import { Fragment, useEffect, useRef, useState, type FormEvent } from 'react';
import type { Role } from '@telesphoros/shared-types';
import { GLOSSARY_EN, HELP_EN } from '@telesphoros/help-content';
import { Button } from '@/components/ui/Button';
import { ContextDrawer } from '@/components/ui/ContextDrawer';
import { answerFor, answerForHit, type HelpAnswer as Answer } from '@/lib/helpConversation';
import { articlesFor, helpScreenOf, type HelpHit } from '@/lib/helpSearch';
import { HELP_WORDS } from '@/lib/helpWords';
import { HelpAnswer, HelpHitList } from './HelpAnswer';

const CORPUS = { articles: HELP_EN.articles, glossary: GLOSSARY_EN };
/** The exchanges kept on screen while the drawer is open; the oldest goes first (plan C1-D2). */
export const HELP_EXCHANGE_LIMIT = 20;

interface Exchange {
  id: number;
  /** What the person typed; null when they chose an article from a list, because they typed nothing (plan C1-D1). */
  asked: string | null;
  answer: Answer;
}

/**
 * Spec 051 slice H2, made a conversation by spec 053 slice C1: the help panel, in the app's side drawer (H-D4). Before anything is asked it
 * shows this screen's articles for these roles. The person asks and presses Enter; Help answers from the reviewed articles and the glossary,
 * refusing a question about a patient before any search (`answerFor`). The conversation lives in this component only: it is cleared when the
 * drawer closes, and nothing typed is sent, stored or put in the address. It reads no patient data.
 */
export function HelpPanel({ open, onClose, pathname, roles }: { open: boolean; onClose: () => void; pathname: string; roles: readonly Role[] }) {
  const [draft, setDraft] = useState('');
  const [exchanges, setExchanges] = useState<Exchange[]>([]);
  const [focusOn, setFocusOn] = useState<number | null>(null);
  const nextId = useRef(1);
  const heading = useRef<HTMLHeadingElement>(null);
  const box = useRef<HTMLInputElement>(null);
  const newest = useRef<HTMLLIElement>(null);
  const forThisPage = articlesFor(HELP_EN.articles, helpScreenOf(pathname), roles).map((article): HelpHit => ({ kind: 'article', article }));
  const newestId = exchanges.at(-1)?.id;

  // The newest answer is brought into view; after a chosen article, the focus moves to its heading so it is read next.
  useEffect(() => {
    newest.current?.scrollIntoView?.({ block: 'start' });
    if (focusOn !== null) document.getElementById(`help-answer-${focusOn}-heading`)?.focus();
  }, [newestId, focusOn]);

  const add = (asked: string | null, answer: Answer) => {
    const id = nextId.current++;
    setExchanges((before) => [...before, { id, asked, answer }].slice(-HELP_EXCHANGE_LIMIT));
    return id;
  };
  const send = (event: FormEvent) => {
    event.preventDefault();
    const asked = draft.trim();
    box.current?.focus();
    if (asked.length === 0) return;
    add(asked, answerFor(asked, CORPUS, pathname, roles));
    setDraft('');
    setFocusOn(null);
  };
  const openHit = (hit: HelpHit) => setFocusOn(add(null, answerForHit(hit)));
  const close = () => {
    setExchanges([]);
    setDraft('');
    setFocusOn(null);
    onClose();
  };

  return (
    <ContextDrawer open={open} onClose={close} title={HELP_WORDS.title} id="help-panel" closeLabel={HELP_WORDS.close} headingRef={heading}>
      <div className="flex min-h-full flex-col gap-4">
        {exchanges.length === 0 ? (
          <div className="flex flex-col gap-4">
            <p>{HELP_WORDS.intro}</p>
            <section aria-labelledby="help-list-heading" className="flex flex-col gap-2">
              <h3 id="help-list-heading" className="font-medium">
                {HELP_WORDS.forThisPage}
              </h3>
              {forThisPage.length === 0 ? (
                <p className="text-sm text-muted-foreground">{HELP_WORDS.nothingForThisPage}</p>
              ) : (
                <HelpHitList hits={forThisPage} onOpen={openHit} />
              )}
            </section>
          </div>
        ) : (
          <div role="log" aria-label={HELP_WORDS.conversation} className="flex flex-col gap-4">
            <ol className="flex flex-col gap-4">
              {exchanges.map((exchange) => (
                <Fragment key={exchange.id}>
                  {exchange.asked !== null && (
                    <li aria-label={HELP_WORDS.you} className="ml-8 flex flex-col gap-1 self-end rounded-lg bg-muted px-3 py-2 break-words">
                      <span aria-hidden="true" className="text-xs font-medium text-muted-foreground">
                        {HELP_WORDS.you}
                      </span>
                      <span>{exchange.asked}</span>
                    </li>
                  )}
                  <li
                    ref={exchange.id === newestId ? newest : undefined}
                    aria-label={HELP_WORDS.helpSays}
                    className="flex flex-col gap-1 rounded-lg border border-border bg-panel px-3 py-2 break-words"
                  >
                    <span aria-hidden="true" className="text-xs font-medium text-muted-foreground">
                      {HELP_WORDS.helpSays}
                    </span>
                    <HelpAnswer answer={exchange.answer} id={`help-answer-${exchange.id}`} onOpen={openHit} onLeave={close} />
                  </li>
                </Fragment>
              ))}
            </ol>
            {exchanges.length >= HELP_EXCHANGE_LIMIT && <p className="text-sm text-muted-foreground">{HELP_WORDS.limit}</p>}
          </div>
        )}
        <form onSubmit={send} className="sticky -bottom-5 mt-auto -mx-5 -mb-5 flex items-end gap-2 border-t border-divider bg-panel px-5 py-3">
          <label className="flex min-w-0 flex-1 flex-col gap-1 text-sm font-medium">
            {HELP_WORDS.ask}
            <input
              ref={box}
              type="text"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              autoComplete="off"
              spellCheck={false}
              enterKeyHint="send"
              className="min-h-control rounded-md border border-input bg-background px-3 text-base font-normal"
            />
          </label>
          <Button type="submit" className="min-h-control">
            {HELP_WORDS.send}
          </Button>
        </form>
      </div>
    </ContextDrawer>
  );
}
