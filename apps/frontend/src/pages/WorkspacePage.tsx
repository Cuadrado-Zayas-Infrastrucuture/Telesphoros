import { useEffect, useState } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { WorkspaceConversation } from '@/components/workspace/WorkspaceConversation';
import { CHAT_PATH } from '@/lib/localWorkspace';
import { onNewChat } from '@/lib/workspaceEvents';

/**
 * The signed-in conversation stays in memory while the physician visits another page. Every destination is a page in the main area (specs/041
 * C1, C2), Settings and "Attach a report" included (spec 052 RC1a, RC-3): nothing opens as a panel over the chat any more. The home at
 * /workspace is the worklist (spec 049); the chat is at /chat until spec 052 RC1b removes it.
 */
export default function WorkspacePage() {
  const { pathname } = useLocation();
  const active = pathname === CHAT_PATH;
  const [conversation, setConversation] = useState(0);
  useEffect(() => onNewChat(() => setConversation((value) => value + 1)), []);
  useEffect(() => {
    if (active) document.title = 'Chat · Telesphoros';
  }, [active]);
  return (
    <>
      <div hidden={!active} className={active ? 'contents' : undefined}>
        <WorkspaceConversation key={conversation} active={active} />
      </div>
      <Outlet />
    </>
  );
}
