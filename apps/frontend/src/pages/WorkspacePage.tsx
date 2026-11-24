import { useEffect, useState } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { ContextDrawer } from '@/components/ui/ContextDrawer';
import { WorkspaceConversation } from '@/components/workspace/WorkspaceConversation';
import { CHAT_PATH } from '@/lib/localWorkspace';
import { onNewChat } from '@/lib/workspaceEvents';

/**
 * The signed-in conversation stays in memory while the physician visits a page or a workspace panel. Patients, Reports and Follow-ups are
 * pages in the main area (specs/041 C1, C2); only the short side tasks that start from the chat or the account menu open as a panel over it
 * (C5). The home at /workspace is the worklist (spec 049); the chat is at /chat.
 */
export default function WorkspacePage() {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const active = pathname === CHAT_PATH;
  const panel = pathname === '/settings' ? 'Account preferences' : pathname === '/reports/upload' ? 'Resume report upload' : null;
  const [conversation, setConversation] = useState(0);
  useEffect(() => onNewChat(() => setConversation((value) => value + 1)), []);
  useEffect(() => {
    if (active) document.title = 'Chat · Telesphoros';
  }, [active]);
  return (
    <>
      <div hidden={!active && !panel} className={active || panel ? 'contents' : undefined}>
        <WorkspaceConversation key={conversation} active={active} />
      </div>
      {panel ? (
        <ContextDrawer key={pathname} id="workspace-panel" title={panel} open onClose={() => navigate(CHAT_PATH)} className="workspace-context-panel">
          <Outlet />
        </ContextDrawer>
      ) : (
        <Outlet />
      )}
    </>
  );
}
