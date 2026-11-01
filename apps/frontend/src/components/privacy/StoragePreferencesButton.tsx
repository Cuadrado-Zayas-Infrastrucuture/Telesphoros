import { Button } from '@/components/ui/Button';
import { useStorageConsent } from './StorageConsentProvider';

export function StoragePreferencesButton({ className }: { className?: string }) {
  const { openPreferences, reopenLabel } = useStorageConsent();
  return (
    <Button variant="ghost" size="sm" className={className} aria-haspopup="dialog" onClick={openPreferences}>
      {reopenLabel}
    </Button>
  );
}
