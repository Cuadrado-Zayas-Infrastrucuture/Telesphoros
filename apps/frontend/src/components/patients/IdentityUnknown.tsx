import { Button } from '@/components/ui/Button';
import { IDENTITY_TABLE } from '@/lib/patientIdentity';
import { useWords } from '@/lib/words/screens';

/**
 * In the banner's place when the identity could not be read now (B-D2). It names the synthetic label, never a name, and its Retry reads the
 * demographics again and nothing else.
 */
export function IdentityUnknown({ label, onRetry }: { label: string; onRetry: () => void }) {
  const words = useWords(IDENTITY_TABLE);
  return (
    <div className="flex flex-col items-start gap-2 border-l-2 border-destructive pl-3">
      <p role="alert" className="text-sm">
        {words.unknown(label)}
      </p>
      <Button variant="outline" size="sm" aria-label={words.retryName} onClick={onRetry}>
        {words.retry}
      </Button>
    </div>
  );
}
