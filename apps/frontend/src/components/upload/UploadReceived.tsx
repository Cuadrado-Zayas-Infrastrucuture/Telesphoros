import { useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import { Alert } from '@/components/ui/Alert';
import { AlertDescription } from '@/components/ui/AlertDescription';
import { AlertTitle } from '@/components/ui/AlertTitle';
import { Button } from '@/components/ui/Button';

/** The result that replaces the upload form. The form, and the Submit button that had focus, are gone: focus moves to the heading to say where the person is. */
export function UploadReceived({ reference, busy, onStartOver }: { reference: string; busy: boolean; onStartOver: () => void }) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus();
  }, []);
  return (
    <div className="flex max-w-prose flex-col gap-4">
      <h1 ref={heading} tabIndex={-1} className="text-3xl leading-tight font-bold focus:outline-none">
        Report received
      </h1>
      <Alert variant="success">
        <AlertTitle>Upload complete</AlertTitle>
        <AlertDescription>
          Reference <strong>{reference}</strong>. The server verified the stored file. This does not indicate clinical review or processing.
        </AlertDescription>
      </Alert>
      <div className="flex flex-wrap items-center gap-3">
        <Button disabled={busy} onClick={onStartOver}>
          Upload another report
        </Button>
        {/* Every build has /reports (b9b5307d), and every uploader holds a role that may read it. */}
        <Button asChild variant="outline">
          <Link to="/reports">View reports</Link>
        </Button>
      </div>
    </div>
  );
}
