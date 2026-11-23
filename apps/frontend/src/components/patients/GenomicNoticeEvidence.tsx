import type { ContextNotice } from '@telesphoros/shared-types';
import { httpsOnly } from '@/lib/citationView';
import { NOTICE_WORDS, noticeSourceLine, noticeTerm } from '@/lib/genomicProfileWords';

/** Spec 045 slice N3, in a row's opened layers: each notice in the source's own terms, where the list says it, and a link to it (PN-7). */
export function GenomicNoticeEvidence({ notices }: { notices: readonly ContextNotice[] | undefined }) {
  if (!notices || notices.length === 0) return null;
  return (
    <section className="flex flex-col gap-1">
      <h5 className="text-sm font-semibold">{NOTICE_WORDS.evidenceHeading}</h5>
      <ul className="flex flex-col gap-2 text-sm">
        {notices.map((notice) => {
          const url = httpsOnly(notice.source.sourceUrl);
          return (
            <li key={`${notice.gene}-${notice.medication.rxcui}`} className="flex flex-col gap-1">
              <span>{noticeTerm(notice)}</span>
              <span>{noticeSourceLine(notice)}</span>
              {url && (
                <a className="underline" href={url} target="_blank" rel="noreferrer">
                  {NOTICE_WORDS.openSource}
                </a>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
