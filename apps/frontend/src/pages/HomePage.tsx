import { ownedStorageMode } from '@/lib/storageMode';
import { useAuth } from '@/auth/AuthProvider';
import { WRITER_ROLES } from '@/auth/roles';
import { Link } from 'react-router-dom';
import helix from '@/assets/helix.png?w=480;960;1440&format=avif;webp;png&as=picture';
import { OptimizedPicture } from '@/components/OptimizedPicture';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { CardDescription } from '@/components/ui/CardDescription';
import { CardHeader } from '@/components/ui/CardHeader';
import { CardTitle } from '@/components/ui/CardTitle';
import { usePageTitle } from '@/hooks/usePageTitle';

const statusCards = [
  {
    title: 'Decision support, not prescribing',
    body: 'Recommendations come from versioned CPIC guideline rules. Nothing here issues or processes prescriptions.',
  },
  {
    title: 'Synthetic data only',
    body: 'No real patient data belongs in this environment until the compliance prerequisites are complete.',
  },
  {
    title: 'Model output is off',
    body: 'Any AI explanation layer stays disabled until clinical sign-off. Rules decide; a model may only explain.',
  },
];

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
  return (
    <div className="flex flex-col gap-10">
      <section aria-labelledby="home-title" className="flex max-w-prose flex-col gap-4">
        <h1 id="home-title" className="text-3xl leading-tight font-bold sm:text-4xl">
          Pharmacogenomic decision support at the point of care
        </h1>
        <p className="text-lg text-muted-foreground">
          Upload a pharmacogenomic report and review CPIC-guided recommendations. This build is the
          synthetic environment: upload verification is available; clinical processing and release remain separate.
        </p>
        <div>
          {canUpload ? <Button asChild size="lg" className="h-auto min-h-control whitespace-normal"><Link to="/reports/upload">Upload a synthetic report</Link></Button>
            : status !== 'signedIn' ? <Button asChild size="lg"><Link to="/signin">Sign in to continue</Link></Button>
              : <p className="text-sm text-muted-foreground">Report upload requires a clinician or admin role.</p>}
        </div>
      </section>

      <section aria-labelledby="status-title" className="flex flex-col gap-4">
        <h2 id="status-title" className="text-xl font-semibold">
          Ground rules for this build
        </h2>
        <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {statusCards.map((card) => (
            <li key={card.title}>
              <Card className="h-full">
                <CardHeader>
                  <CardTitle as="h3">{card.title}</CardTitle>
                  <CardDescription>{card.body}</CardDescription>
                </CardHeader>
              </Card>
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="how-title" className="flex flex-col gap-4">
        <h2 id="how-title" className="text-xl font-semibold">
          From report to recommendation
        </h2>
        <p className="max-w-prose text-muted-foreground">
          A report becomes a genotype, then a phenotype, then a guideline-based recommendation that a
          clinician reviews.
        </p>
        <OptimizedPicture
          picture={helix}
          alt="Stylised double helix drawn as two blue strands joined by light-blue rungs"
          sizes="(min-width: 72rem) 72rem, 100vw"
          className="h-auto w-full rounded-lg border border-divider"
        />
      </section>
    </div>
  );
}
