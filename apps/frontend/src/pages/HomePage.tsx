import { ownedStorageMode } from '@/lib/storageMode';
import { useAuth } from '@/auth/AuthProvider';
import { WRITER_ROLES } from '@/auth/roles';
import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/Button';
import { ProductLanding } from '@/components/landing/ProductLanding';
import { usePageTitle } from '@/hooks/usePageTitle';

export default function HomePage() {
  usePageTitle('Overview');
  const { roles, status } = useAuth();
  const canUpload = roles.some(role => WRITER_ROLES.includes(role));
  const canRead = status === 'signedIn' && roles.length > 0;
  if (ownedStorageMode()) return (
    <div className="flex max-w-prose flex-col gap-6">
      <h1 className="text-3xl font-bold">Synthetic report storage</h1>
      <p>Upload and retrieve synthetic PDF, VCF and JSON files. The server verifies file storage; clinical processing is disabled.</p>
      <p>Use synthetic records only. No clinical interpretation or recommendations are produced.</p>
      <div className="flex flex-wrap gap-4">
        {canUpload && <Button asChild><Link to="/reports/upload">Upload a synthetic report</Link></Button>}
        {canRead && <Button asChild variant="outline"><Link to="/reports">View reports</Link></Button>}
        {status !== 'signedIn' && <Button asChild><Link to="/signin">Sign in to continue</Link></Button>}
      </div>
    </div>
  );
  return <ProductLanding canUpload={canUpload} signedIn={status === 'signedIn'} />;
}
