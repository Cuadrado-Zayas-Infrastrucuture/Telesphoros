import type { KeyboardEvent } from 'react';

/** The account menu's shared row styles and key handler type (specs/034 D10, D11): a row is 36px under a mouse and 44px on touch (workspace.css). */
export const ACCOUNT_MENU_ROW = 'account-menu-row flex w-full items-center gap-3 rounded-sm px-3 text-left text-sm hover:bg-muted';
export const ACCOUNT_MENU_ICON = 'size-4 shrink-0 text-muted-foreground';
export type AccountMenuKeyHandler = (event: KeyboardEvent<HTMLElement>) => void;
