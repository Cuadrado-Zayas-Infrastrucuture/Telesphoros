import { useEffect, useState } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { ContextDrawer } from '@/components/ui/ContextDrawer';
import { WorkspaceConversation } from '@/components/workspace/WorkspaceConversation';
import { onNewChat } from '@/lib/workspaceEvents';

/** The signed-in conversation stays in memory while the physician visits a patient or a workspace panel. */
export default function WorkspacePage() {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const active = pathname === '/workspace';
  const panel = pathname === '/reports' ? 'Report history' : pathname === '/settings' ? 'Account preferences' : pathname === '/reports/upload' ? 'Resume report upload' : null;
  const [conversation, setConversation] = useState(0);
  useEffect(() => onNewChat(() => setConversation((value) => value + 1)), []);
  useEffect(() => {
    if (active) document.title = 'Workspace · Telesphoros';
  }, [active]);
  return (
    <>
      <div hidden={!active && !panel} className={active || panel ? 'contents' : undefined}>
        <WorkspaceConversation key={conversation} active={active} />
      </div>
      {panel ? (
        <ContextDrawer key={pathname} id="workspace-panel" title={panel} open onClose={() => navigate('/workspace')} className="workspace-context-panel">
          <Outlet />
        </ContextDrawer>
      ) : (
        <Outlet />
      )}
    </>
  );
}
