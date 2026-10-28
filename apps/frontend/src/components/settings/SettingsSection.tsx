import type { ReactNode } from 'react';
import { Card } from '@/components/ui/Card';
import { CardContent } from '@/components/ui/CardContent';
import { CardDescription } from '@/components/ui/CardDescription';
import { CardHeader } from '@/components/ui/CardHeader';
import { CardTitle } from '@/components/ui/CardTitle';

/** One titled group on the Settings page; the heading names the region for assistive technology. */
export function SettingsSection({ id, title, description, children }: { id: string; title: string; description?: string; children: ReactNode }) {
  return (
    <section aria-labelledby={id}>
      <Card>
        <CardHeader>
          <CardTitle id={id} className="text-lg">
            {title}
          </CardTitle>
          {description && <CardDescription>{description}</CardDescription>}
        </CardHeader>
        <CardContent>{children}</CardContent>
      </Card>
    </section>
  );
}
