import { Button } from '@/components/ui/Button';
import { IDENTITY_WORDS } from '@/lib/patientIdentity';

/**
 * In the banner's place when the identity could not be read now (B-D2). It names the synthetic label, never a name, and its Retry reads the
 * demographics again and nothing else.
 */
export function IdentityUnknown({ label, onRetry }: { label: string; onRetry: () => void }) {
  return (
    <div className="flex flex-col items-start gap-2 border-l-2 border-destructive pl-3">
      <p role="alert" className="text-sm">
        {IDENTITY_WORDS.unknown(label)}
      </p>
      <Button variant="outline" size="sm" aria-label={IDENTITY_WORDS.retryName} onClick={onRetry}>
        {IDENTITY_WORDS.retry}
      </Button>
    </div>
  );
}
