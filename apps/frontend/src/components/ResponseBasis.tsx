import { Reasoning } from '@/components/prompt-kit/Reasoning';
import { DEMO_QUESTIONS } from '@/lib/interpretationDemo';

export function ResponseBasis({ question }: { question: string }) {
  const matched = DEMO_QUESTIONS.some(sample => sample === question.trim());
  return <Reasoning><dl className="space-y-2"><div className="flex flex-wrap gap-x-2"><dt className="font-medium text-foreground">Input</dt><dd>Sample question only.</dd></div><div className="flex flex-wrap gap-x-2"><dt className="font-medium text-foreground">Response selection</dt><dd>{matched ? 'The question matched a bundled example. Its fixed response was displayed.' : 'No bundled question matched. The fixed fallback response was displayed.'}</dd></div><div className="flex flex-wrap gap-x-2"><dt className="font-medium text-foreground">Limits</dt><dd>No uploaded content or clinical evidence was assessed, and no model reasoning occurred.</dd></div></dl></Reasoning>;
}
