import { useLayoutEffect, type RefObject } from 'react';

/**
 * Scroll entrances for the landing (a rise into place; opacity is never changed, so contrast is always real).
 * Content sits at its final place unless this hook has run: it adds `is-motion` to the
 * landing root only when IntersectionObserver exists and the visitor has not asked for reduced motion, so a
 * failure, an old browser or reduced motion all leave every block readable. Elements carry `data-reveal`;
 * each is revealed once, including ones the visitor jumped past with an anchor link.
 */
export function useLandingMotion(root: RefObject<HTMLElement | null>) {
  useLayoutEffect(() => {
    const element = root.current;
    if (!element || typeof IntersectionObserver === 'undefined') return;
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    const targets = Array.from(element.querySelectorAll<HTMLElement>('*')).filter(node => 'reveal' in node.dataset);
    const observer = new IntersectionObserver(entries => {
      for (const entry of entries) {
        if (entry.isIntersecting || entry.boundingClientRect.top < 0) {
          entry.target.classList.add('is-revealed');
          observer.unobserve(entry.target);
        }
      }
    }, { threshold: 0.12, rootMargin: '0px 0px -8% 0px' });
    element.classList.add('is-motion');
    for (const target of targets) observer.observe(target);
    return () => {
      observer.disconnect();
      element.classList.remove('is-motion');
      for (const target of targets) target.classList.remove('is-revealed');
    };
  }, [root]);
}
