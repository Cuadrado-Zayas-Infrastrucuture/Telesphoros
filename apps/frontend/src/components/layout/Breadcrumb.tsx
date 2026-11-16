import { Link } from 'react-router-dom';

/**
 * Where this page sits (specs/041 C4): each earlier level is a link, the current page is plain text marked `aria-current`. It replaces
 * "Back to chat" on the patient pages; the chat stays one click away in the sidebar.
 */
export function Breadcrumb({ trail, current }: { trail: { to: string; label: string }[]; current: string }) {
  return (
    <nav aria-label="Breadcrumb" className="text-sm text-muted-foreground">
      <ol className="flex flex-wrap items-center gap-x-2">
        {trail.map((step) => (
          <li key={step.to} className="flex items-center gap-x-2">
            <Link to={step.to} className="inline-flex min-h-control items-center underline-offset-2 hover:underline">
              {step.label}
            </Link>
            <span aria-hidden="true">/</span>
          </li>
        ))}
        <li aria-current="page" className="wrap-anywhere text-foreground">
          {current}
        </li>
      </ol>
    </nav>
  );
}
