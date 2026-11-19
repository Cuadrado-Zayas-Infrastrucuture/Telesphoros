import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import type { ReactElement } from 'react';
import '@/styles/tooltip.css';

const OPEN_DELAY_MS = 250;
const GAP_PX = 8;
const EDGE_PX = 12;

/**
 * Shows a control's name beside it, on hover and on keyboard focus (specs/042 D1). For icon-only controls: the child keeps its own
 * `aria-label`, and `label` repeats that name for people who see the icon. A fact, a status or a safety statement never lives only
 * here (D3): touch users rarely see a tooltip, and the keyboard never reaches a disabled control's.
 */
export function Tooltip({ label, side = 'top', children }: { label: string; side?: 'top' | 'bottom' | 'left' | 'right'; children: ReactElement }) {
  return (
    <TooltipPrimitive.Provider delayDuration={OPEN_DELAY_MS}>
      <TooltipPrimitive.Root>
        <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
        <TooltipPrimitive.Portal>
          <TooltipPrimitive.Content className="tooltip" side={side} sideOffset={GAP_PX} collisionPadding={EDGE_PX}>
            {label}
          </TooltipPrimitive.Content>
        </TooltipPrimitive.Portal>
      </TooltipPrimitive.Root>
    </TooltipPrimitive.Provider>
  );
}
