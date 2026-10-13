// Adapted from Prompt Kit; animation/colors use local tokens and reduced-motion support.
import type { ReactNode } from 'react';
export function TextShimmer({ children }: { children: ReactNode }) {
  return <span className="preview-shimmer font-medium">{children}</span>;
}
