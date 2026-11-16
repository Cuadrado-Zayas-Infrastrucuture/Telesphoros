import { Link } from 'react-router-dom';

/**
 * Returns to the conversation in progress, with its unsent question and attachment (specs/041 C4). The sidebar's "New chat" starts a new
 * conversation instead, so a page that a clinician may visit in the middle of a chat keeps this link beside its breadcrumb or heading.
 */
export function BackToChatLink() {
  return (
    <Link to="/workspace" className="inline-flex min-h-control items-center text-sm text-muted-foreground underline-offset-2 hover:underline">
      Back to chat
    </Link>
  );
}
