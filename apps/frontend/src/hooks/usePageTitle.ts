import { useEffect } from 'react';

/** Keeps the tab title (and screen-reader page announcement) in step with the route. */
export function usePageTitle(title: string) {
  useEffect(() => {
    document.title = `${title} · Telesphoros Remastered`;
  }, [title]);
}
