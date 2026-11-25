import { Link } from 'react-router-dom';
import { WORKSPACE_PATH } from '@/lib/localWorkspace';

/**
 * Returns to the worklist, the signed-in home (spec 049 section 5; it was "Back to chat", specs/041 C4). The chat itself is gone
 * (spec 052 RC1b).
 */
export function BackToHomeLink() {
  return (
    <Link to={WORKSPACE_PATH} className="inline-flex min-h-control items-center text-sm text-muted-foreground underline-offset-2 hover:underline">
      Back to home
    </Link>
  );
}
