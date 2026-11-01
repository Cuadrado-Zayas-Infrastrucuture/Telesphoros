import { StorageConsentProvider } from '@/components/privacy/StorageConsentProvider';
import { AppFrame } from './AppFrame';

export function AppLayout() {
  return (
    <StorageConsentProvider>
      <AppFrame />
    </StorageConsentProvider>
  );
}
