import { useShellCopy } from '@/lib/landing/landing-language';

/** First focusable element on every page: lets keyboard users jump past the navigation. */
export function SkipLink() {
  const { header } = useShellCopy();
  return (
    <a
      href="#main"
      className="sr-only rounded-md bg-primary px-4 py-2 text-primary-foreground focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-10"
    >
      {header.skip}
    </a>
  );
}
