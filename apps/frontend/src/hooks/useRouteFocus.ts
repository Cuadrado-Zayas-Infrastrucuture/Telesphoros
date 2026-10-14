import { useEffect, useRef, type RefObject } from 'react';
import { useLocation } from 'react-router-dom';

/**
 * After client-side navigation, move focus to the main region so keyboard and screen-reader
 * users land on the new content instead of staying on the link they activated.
 * Skips the first render so the page doesn't steal focus on load.
 */
export function useRouteFocus(target: RefObject<HTMLElement | null>, includeHeader = false) {
  const { pathname } = useLocation();
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    target.current?.focus({ preventScroll: includeHeader });
    if (includeHeader) window.scrollTo(0, 0);
  }, [pathname, target, includeHeader]);
}
