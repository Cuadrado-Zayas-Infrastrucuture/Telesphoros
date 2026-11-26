import { Link } from 'react-router-dom';
import { HELP_SCREENS } from '@telesphoros/help-content';
import type { HelpHit } from '@/lib/helpSearch';
import { HELP_WORDS, helpFoot } from '@/lib/helpWords';

/** How a hit is named on a button: an article by its title, a glossary word as "Word: term". */
export const hitTitle = (hit: HelpHit) => (hit.kind === 'article' ? hit.article.title : `${HELP_WORDS.word}: ${hit.entry.term}`);
/** How a quoted hit is headed: "From: title" for an article, "Word: term" for a glossary word. */
export const quoteHeading = (hit: HelpHit) => (hit.kind === 'article' ? `${HELP_WORDS.from}: ${hit.article.title}` : hitTitle(hit));

/**
 * Spec 053 slice C1: one article or glossary word, quoted whole in Help's answer: its paragraphs, its links to the app's screens, and its
 * foot (the draft line, or who signed it). The words are the reviewed content's own; nothing is reworded.
 */
export function HelpQuote({ hit, headingId, onLeave }: { hit: HelpHit; headingId: string; onLeave: () => void }) {
  return (
    <article aria-labelledby={headingId} className="flex flex-col gap-3">
      <h3 id={headingId} tabIndex={-1} className="font-medium">
        {quoteHeading(hit)}
      </h3>
      {hit.kind === 'article' ? hit.article.body.map((paragraph) => <p key={paragraph}>{paragraph}</p>) : <p>{hit.entry.body}</p>}
      {hit.kind === 'article' && hit.article.links.length > 0 && (
        <ul className="flex flex-col gap-1">
          {hit.article.links.map((link) => (
            <li key={link.screen}>
              <Link to={HELP_SCREENS[link.screen]} onClick={onLeave} className="inline-flex min-h-control items-center font-medium underline underline-offset-2">
                {link.label}
              </Link>
            </li>
          ))}
        </ul>
      )}
      <p className="text-sm text-muted-foreground">{helpFoot(hit.kind === 'article' ? hit.article : hit.entry)}</p>
    </article>
  );
}
