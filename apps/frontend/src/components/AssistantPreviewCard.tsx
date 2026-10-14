import { SyntheticAssistant } from '@/components/SyntheticAssistant';

export function AssistantPreviewCard() {
  return (
    <section aria-label="AI-assisted PGx preview"><details id="ai-assistant" open className="dashboard-assistant min-w-0 rounded-lg border border-divider bg-panel p-3">
      <summary className="min-h-control cursor-pointer py-1 text-base font-medium">AI-assisted PGx preview</summary>
      <p className="mb-2 text-xs leading-relaxed text-muted-foreground">Fixed synthetic responses. No live model or CPIC mapping. Reports and patient data are not used.</p>
      <SyntheticAssistant embedded />
    </details></section>
  );
}
