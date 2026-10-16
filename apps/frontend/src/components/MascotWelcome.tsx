import type { ReactNode } from 'react';
import mascot from '@/assets/telesphoros-mascot.png';
import '@/styles/mascot-welcome.css';

/** Approved layouts: Companion for the landing, Centered for the AI welcome. */
export function MascotWelcome({ context, children, alt = 'Telesphoros mascot in a teal cloak' }: { context: 'landing' | 'assistant'; children: ReactNode; alt?: string }) {
  const variant = context === 'landing' ? 'companion' : 'centered';
  return <div className={`mascot-welcome mascot-welcome--${context} mascot-welcome--${variant}`} data-mascot-context={context} data-mascot-variant={variant}>
    <img className="mascot-welcome-image" src={mascot} width="162" height="192" alt={alt} loading={context === 'landing' ? 'lazy' : 'eager'} decoding="async" />
    <div className="mascot-welcome-content">{children}</div>
  </div>;
}
