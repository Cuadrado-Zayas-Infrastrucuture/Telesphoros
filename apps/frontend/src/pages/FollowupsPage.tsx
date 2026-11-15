import { FollowupInbox } from '@/components/workspace/FollowupInbox';
import { usePageTitle } from '@/hooks/usePageTitle';

/** The clinic's follow-ups as a page, opened from the sidebar like Patients and Reports (specs/041 C2). */
export default function FollowupsPage() {
  usePageTitle('Follow-ups');
  return (
    <div className="flex max-w-3xl flex-col gap-4">
      <h1 className="text-2xl font-semibold">Follow-ups</h1>
      <FollowupInbox />
    </div>
  );
}
