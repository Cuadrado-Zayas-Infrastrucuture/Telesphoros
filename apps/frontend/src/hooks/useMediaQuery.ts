import { useCallback, useSyncExternalStore } from 'react';

/**
 * Whether a media query matches now, kept in step as the window changes. Where the browser cannot answer (jsdom has no `matchMedia`),
 * it reports `fallback`.
 */
export function useMediaQuery(query: string, fallback: boolean): boolean {
  const list = useCallback(() => (typeof window.matchMedia === 'function' ? window.matchMedia(query) : undefined), [query]);
  const subscribe = useCallback(
    (notify: () => void) => {
      const current = list();
      current?.addEventListener('change', notify);
      return () => current?.removeEventListener('change', notify);
    },
    [list],
  );
  return useSyncExternalStore(
    subscribe,
    () => list()?.matches ?? fallback,
    () => fallback,
  );
}
