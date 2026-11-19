import { Slot } from '@radix-ui/react-slot';
import { useEffect, useLayoutEffect, useRef, useState, type ReactElement } from 'react';

type Loaded = typeof import('./Tooltip').Tooltip;

// One load for the whole page, kept once it arrives.
let loaded: Loaded | null = null;
let loading: Promise<void> | null = null;
function load(): Promise<void> {
  loading ??= import('./Tooltip').then((module) => {
    loaded = module.Tooltip;
  });
  return loading;
}

/**
 * `Tooltip` for code in the file every page loads first, the sidebar (specs/042 D9). The control shows at once; the tooltip's code is
 * fetched after the first render, once per page, and wraps the control when it arrives. Wrapping replaces the control's element, so
 * if the control holds the keyboard focus at that moment, the focus is handed to its replacement. Same properties as `Tooltip`.
 */
export function LazyTooltip({ label, side, children }: { label: string | undefined; side?: 'top' | 'bottom' | 'left' | 'right'; children: ReactElement }) {
  const [, arrived] = useState(false);
  // The control's element, whichever copy is on the page. `Slot` adds this reference to the control's own.
  const node = useRef<HTMLElement>(null);
  const refocus = useRef(false);
  const wanted = label !== undefined;
  useEffect(() => {
    if (!wanted || loaded) return;
    let mounted = true;
    void load().then(() => {
      if (!mounted) return;
      refocus.current = node.current !== null && node.current === document.activeElement;
      arrived(true);
    });
    return () => {
      mounted = false;
    };
  }, [wanted]);
  useLayoutEffect(() => {
    if (!refocus.current) return;
    refocus.current = false;
    node.current?.focus();
  });
  if (!wanted) return children;
  const control = <Slot ref={node}>{children}</Slot>;
  const Tooltip = loaded;
  return Tooltip ? (
    <Tooltip label={label} side={side}>
      {control}
    </Tooltip>
  ) : (
    control
  );
}
