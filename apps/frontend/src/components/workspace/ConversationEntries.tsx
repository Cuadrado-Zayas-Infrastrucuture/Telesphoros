import { FileText } from 'lucide-react';
import type { ReportStatus } from '@telesphoros/shared-types';
import { ChatLoading } from '@/components/prompt-kit/ChatLoading';
import { Steps } from '@/components/prompt-kit/Steps';
import { SystemMessage } from '@/components/prompt-kit/SystemMessage';
import { ReportStatusText } from '@/components/ReportStatusText';
import { Button } from '@/components/ui/Button';
import { UPLOAD_STEPS, UPLOAD_WORDS } from '@/lib/uploadSteps';

/** The only reply to a typed question outside the local preview (specs/024 D3): a note, never an answer. */
const NOT_AVAILABLE = 'Interpretation is not available in the prototype yet.';

export type UploadEntry = {
  kind: 'upload';
  id: number;
  filename: string;
  note?: string;
  patient: string;
  patientId: string;
  stage: number;
  phase: 'uploading' | 'sent' | 'failed';
  message?: string;
  reportId?: string;
  status?: ReportStatus;
  checking?: boolean;
  checkNote?: string;
};
export type Entry = { kind: 'question'; id: number; text: string } | UploadEntry;

/** What has happened in this chat: typed questions with their note, and uploads with their progress and status word. */
export function ConversationEntries({ entries, onCheckStatus }: { entries: Entry[]; onCheckStatus: (entry: UploadEntry) => void }) {
  return (
    <section aria-label="Conversation" aria-live="polite" className="flex flex-1 flex-col gap-5 py-6">
      <h1 className="sr-only">Workspace</h1>
      {entries.map((entry) =>
        entry.kind === 'question' ? (
          <div key={entry.id} className="flex flex-col gap-3">
            <p className="one-screen-you self-end rounded-2xl bg-surface px-4 py-2 break-words">{entry.text}</p>
            <SystemMessage>{NOT_AVAILABLE}</SystemMessage>
          </div>
        ) : (
          <div key={entry.id} className="flex flex-col gap-2">
            <span className="inline-flex max-w-full items-center gap-2 self-end rounded-lg border border-divider bg-panel px-3 py-1.5 text-sm">
              <FileText aria-hidden="true" className="size-4 shrink-0" />
              <span className="min-w-0 truncate">
                {entry.filename} · {entry.patient}
              </span>
            </span>
            {entry.note && <p className="one-screen-you self-end rounded-2xl bg-surface px-4 py-2 break-words">{entry.note}</p>}
            <Steps stage={entry.stage} failed={entry.phase === 'failed'} labels={UPLOAD_STEPS} words={UPLOAD_WORDS} label={`Upload of ${entry.filename}`} colored />
            {entry.phase === 'uploading' && <ChatLoading label="Uploading your report…" />}
            {entry.checking && <ChatLoading label="Checking report status…" />}
            {entry.phase === 'failed' && <SystemMessage error>{entry.message}</SystemMessage>}
            {entry.phase === 'sent' && entry.status && (
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                <span className="text-muted-foreground">Report status</span>
                <ReportStatusText status={entry.status} className="font-medium" />
                <Button variant="outline" size="sm" pending={entry.checking} pendingLabel="Checking status…" onClick={() => onCheckStatus(entry)}>
                  Check status
                </Button>
                {entry.checkNote && <span className="text-muted-foreground">{entry.checkNote}</span>}
              </div>
            )}
          </div>
        ),
      )}
    </section>
  );
}
