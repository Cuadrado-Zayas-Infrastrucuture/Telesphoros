import { useLocation } from 'react-router-dom';
import { WorkspaceConversation } from '@/components/workspace/WorkspaceConversation';
import { usePageTitle } from '@/hooks/usePageTitle';

/**
 * The chat-first home, in every build (specs/024). The feature panel is the shared sidebar. Each navigation to this address (the panel's "New chat"
 * included) has its own location key, and keying the conversation on it is what starts a new chat empty.
 */
export default function WorkspacePage() {
  usePageTitle('Workspace');
  const { key } = useLocation();
  return <WorkspaceConversation key={key} />;
}
