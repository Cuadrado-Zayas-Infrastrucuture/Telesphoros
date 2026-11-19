import type { RefAttributes } from 'react';
import { NavLink, type NavLinkProps } from 'react-router-dom';

/**
 * A sidebar destination that can sit inside `Tooltip` (specs/042 D8). The tooltip hands its child a merged set of properties and joins
 * class names as text, which would turn `NavLink`'s class-name function into a string. Here the function travels as `styleFor`, and
 * everything else, the tooltip's handlers and reference included, passes straight through to the link.
 */
export function SidebarLink({ styleFor, ...props }: Omit<NavLinkProps, 'className'> & RefAttributes<HTMLAnchorElement> & { styleFor: (state: { isActive: boolean }) => string }) {
  return <NavLink {...props} className={styleFor} />;
}
